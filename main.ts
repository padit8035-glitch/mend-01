// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move pairs (old, new) recorded by move edits that succeeded, for the R output lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 3: a file as lines, its own line break, and whether it ends with one. ----
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}
function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}
function joinFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---- Section 5: matching lines at three tiers. ----
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const pos: number[] = [];
  const on = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (normLine(lines[i + k]!, tier) !== on[k]) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}
/** The first tier (0..2, or 0 only when strict) at which o occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(lines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}
/** The first occurrence of o at or after `from`, at the first tier with one. */
function findTierFrom(
  lines: string[],
  o: string[],
  from: number,
  strict: boolean,
  eofOnly: boolean,
): { tier: number; pos: number } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, o, t).filter((p) => p >= from && (!eofOnly || p + o.length === lines.length));
    if (occ.length > 0) return { tier: t, pos: occ[0]! };
  }
  return null;
}
/** The first line at or after `from` equal to a single-line anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const want = normLine(anchor, t);
    for (let k = from; k < lines.length; k++) {
      if (normLine(lines[k]!, t) === want) return k;
    }
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line at O index ctx) or an added line. */
interface NLine {
  text: string;
  ctx: number | null;
}
/** Build the lines that replace O at pos, following section 5 (context lines, tier-2 re-indent). */
function buildReplacement(fileLines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  const lead = (s: string): string => (s.match(/^[ \t]*/) ?? [''])[0]!;
  const f = tier === 2 ? lead(fileLines[pos] ?? '') : '';
  const p = tier === 2 ? lead(o[0] ?? '') : '';
  for (const nl of n) {
    if (nl.ctx !== null) {
      out.push(fileLines[pos + nl.ctx]!);
    } else if (tier === 2) {
      const t = nl.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

/** Apply O -> N at pos in a file model (the caller owns the final-break rule). */
function applyAt(f: FileModel, pos: number, o: string[], n: NLine[], tier: number): void {
  const rep = buildReplacement(f.lines, pos, o, n, tier);
  f.lines = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + o.length)];
}

// ---- Section 6: unified diffs. ----
interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  backslashAfterLast: boolean;
  backslashAfterLastPlus: boolean;
}
interface UnifiedSection {
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Hunk[];
}
function newUnifiedSection(): UnifiedSection {
  return {
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    diffOld: null,
    diffNew: null,
    createFlag: false,
    deleteFlag: false,
    hunks: [],
  };
}
/** A --- / +++ path: text after the four characters, up to the first tab, spaces removed, a/ or b/ stripped. */
function patchPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** Parse one hunk body starting at j (first line after the header); returns the hunk and the next index. */
function parseHunkBody(lines: string[], j: number): { hunk: Hunk; next: number } {
  let i = j;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
      i++;
    } else break;
  }
  // Empty lines at the end of a body are not part of it (a line of one space is a context line, kept).
  let end = i;
  while (end > j) {
    const prev = lines[end - 1]!;
    if (prev === '') end--;
    else break;
  }
  // Rebuild items from lines[j..end) so the trim is exact.
  const trimmed: { kind: 'ctx' | 'old' | 'new'; text: string; backslash: boolean }[] = [];
  for (let k = j; k < end; k++) {
    const line = lines[k]!;
    if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      const kind = line === '' || line.startsWith(' ') ? 'ctx' : line.startsWith('-') ? 'old' : 'new';
      trimmed.push({ kind, text: line === '' ? '' : line.slice(1), backslash: false });
    } else if (line.startsWith('\\')) {
      if (trimmed.length > 0) trimmed[trimmed.length - 1]!.backslash = true;
    }
  }
  const o: string[] = [];
  const n: NLine[] = [];
  for (const it of trimmed) {
    if (it.kind === 'ctx') {
      n.push({ text: it.text, ctx: o.length });
      o.push(it.text);
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else {
      n.push({ text: it.text, ctx: null });
    }
  }
  let backslashAfterLast = false;
  let backslashAfterLastPlus = false;
  for (let k = trimmed.length - 1; k >= 0; k--) {
    const it = trimmed[k]!;
    if (it.kind === 'ctx' || it.kind === 'new') {
      backslashAfterLast = it.backslash;
      break;
    }
  }
  for (let k = trimmed.length - 1; k >= 0; k--) {
    const it = trimmed[k]!;
    if (it.kind === 'new') {
      backslashAfterLastPlus = it.backslash;
      break;
    }
  }
  return { hunk: { a: 0, o, n, backslashAfterLast, backslashAfterLastPlus }, next: end };
}
/** Parse the header and hunks of one section starting at i; returns the index of the next section start or end. */
function parseUnifiedSection(lines: string[], i: number, sec: UnifiedSection): number {
  let seenHunk = false;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) return i;
    if (line.startsWith('--- ')) {
      if (!seenHunk) {
        const next = lines[i + 1] ?? '';
        if (!next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        sec.pairOld = patchPath(line);
        sec.pairNew = patchPath(next);
        i += 2;
        continue;
      }
      if ((lines[i + 1] ?? '').startsWith('+++ ')) return i;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const body = parseHunkBody(lines, i + 1);
      body.hunk.a = parseInt(m[1]!, 10);
      sec.hunks.push(body.hunk);
      seenHunk = true;
      i = body.next;
      continue;
    }
    if (!seenHunk) {
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length);
      else if (line === 'new file mode' || line.startsWith('new file mode ')) sec.createFlag = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) sec.deleteFlag = true;
      i++;
      continue;
    }
    i++;
  }
  return i;
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const sec = newUnifiedSection();
      sec.diffOld = m[1]!;
      sec.diffNew = m[2]!;
      sections.push(sec);
      i = parseUnifiedSection(lines, i + 1, sec);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec = newUnifiedSection();
      sections.push(sec);
      i = parseUnifiedSection(lines, i, sec);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}
function unifiedSectionEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    const rawOld = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
    const rawNew = sec.pairNew ?? sec.renameTo ?? sec.diffNew;
    const oldPath = rawOld === '/dev/null' ? null : rawOld;
    const newPath = rawNew === '/dev/null' ? null : rawNew;
    const isCreate = sec.createFlag || oldPath === null;
    const isDelete = !isCreate && (sec.deleteFlag || newPath === null);
    if (isCreate) {
      const p = newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const nl of h.n) {
          if (nl.ctx === null) plus.push(nl.text);
        }
      }
      // A created file ends with a line break unless a \ line follows its last + line.
      let finalBreak = true;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        if (h.n.some((nl) => nl.ctx === null)) {
          finalBreak = !h.backslashAfterLastPlus;
          break;
        }
      }
      if (plus.length === 0) {
        tree.now.set(p, '');
      } else {
        tree.now.set(p, plus.join('\n') + (finalBreak ? '\n' : ''));
      }
      return;
    }
    if (isDelete) {
      const p = oldPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = oldPath ?? '';
    const newP = newPath ?? '';
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const isMove = oldP !== newP;
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const f = splitFile(before);
    applyUnifiedHunks(f, sec.hunks, strict, oldP);
    const out = joinFile(f);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}
function applyUnifiedHunks(f: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const atEnd = pos === f.lines.length;
      applyAt(f, pos, [], h.n, 0);
      if (atEnd) f.final = !h.backslashAfterLast;
      d += h.n.length;
      continue;
    }
    const found = findTier(f.lines, h.o, strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const pos = best;
    const endsAtEnd = pos + h.o.length === f.lines.length;
    applyAt(f, pos, h.o, h.n, found.tier);
    if (endsAtEnd) f.final = !h.backslashAfterLast;
    d += h.n.length - h.o.length;
  }
}

// ---- Section 7: SEARCH/REPLACE blocks. ----
interface SrBlock {
  path: string;
  old: string[];
  next: string[];
  searchLine: number;
}
function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      let path: string | null = null;
      for (let j = searchIdx - 1; j > prevReplace; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      blocks.push({ path, old: lines.slice(searchIdx + 1, eq), next: lines.slice(eq + 1, rep), searchLine: searchIdx + 1 });
      prevPath = path;
      prevReplace = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srBlockEdit(b, strict));
}
function srBlockEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.next.length === 0 ? '' : `${b.next.join('\n')}\n`);
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const f = splitFile(cur);
    const found = findTier(f.lines, b.old, strict);
    if (!found) throw new Fail('no-match', p);
    if (found.pos.length > 1) throw new Fail('ambiguous', p);
    const pos = found.pos[0]!;
    applyAt(f, pos, b.old, b.next.map((t) => ({ text: t, ctx: null })), found.tier);
    tree.now.set(p, joinFile(f));
  };
}

// ---- Section 8: V4A patches. ----
interface V4aChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const end = last;
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < end) {
        const l = lines[j]!;
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (blank(l)) {
          // A blank line: trailing when only blank lines follow up to a section start or End Patch.
          let k = j;
          while (k < end && blank(lines[k]!)) k++;
          if (k >= end || isSectionStart(lines[k]!) || lines[k]!.trim() === '*** End Patch') break;
          if (l === '') {
            raw.push(l);
            j++;
            continue;
          }
          throw new Exit2(`error: parse ${j + 1}`);
        }
        if (l.startsWith('+')) raw.push(l);
        else throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const fileLines = raw.map((l) => (l === '' ? '' : l.slice(1)));
      edits.push(((p, fl) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fl.length === 0 ? '' : `${fl.join('\n')}\n`);
      })(path, fileLines));
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < end && blank(lines[j]!)) j++;
      if (j < end && !isSectionStart(lines[j]!) && lines[j]!.trim() !== '*** End Patch') {
        throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push(((p) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      })(path));
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      let moveTo: string | null = null;
      const chunks: V4aChunk[] = [];
      let j = i + 1;
      let cur: V4aChunk | null = null;
      let firstLine = true;
      while (j < end) {
        const l = lines[j]!;
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('*** Move to: ')) {
          if (!firstLine || cur !== null) throw new Exit2(`error: parse ${j + 1}`);
          moveTo = l.slice('*** Move to: '.length).trim();
          firstLine = false;
          j++;
          continue;
        }
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim(), o: [], n: [], eof: false };
          chunks.push(cur);
          firstLine = false;
          j++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          cur = null;
          firstLine = false;
          j++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (blank(l)) {
            // A blank line: trailing when only blank lines follow up to a section start or End Patch.
            let k = j;
            while (k < end && blank(lines[k]!)) k++;
            if (k >= end || isSectionStart(lines[k]!) || lines[k]!.trim() === '*** End Patch') break;
          }
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: null, o: [], n: [], eof: false };
              chunks.push(cur);
            } else {
              throw new Exit2(`error: parse ${j + 1}`);
            }
          }
          if (l === '' || l.startsWith(' ')) {
            const text = l === '' ? '' : l.slice(1);
            cur.n.push({ text, ctx: cur.o.length });
            cur.o.push(text);
          } else if (l.startsWith('-')) {
            cur.o.push(l.slice(1));
          } else {
            cur.n.push({ text: l.slice(1), ctx: null });
          }
          firstLine = false;
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(cur);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        const at = findAnchor(f.lines, chunk.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (chunk.o.length === 0) {
        const pos = chunk.eof ? f.lines.length : cursor;
        applyAt(f, pos, [], chunk.n, 0);
        cursor = pos + chunk.n.length;
        continue;
      }
      const found = findTierFrom(f.lines, chunk.o, cursor, strict, chunk.eof);
      if (!found) throw new Fail('no-match', path);
      const pos = found.pos;
      applyAt(f, pos, chunk.o, chunk.n, found.tier);
      cursor = pos + chunk.n.length;
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Rows: one per changed path, byte order; a successful move prints R old -> new (sorted by new)
  // instead of the pair's D and A lines.
  const rPairs: [string, string][] = [];
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null) {
      rPairs.push([o, n]);
    }
  }
  const inR = (p: string): boolean => rPairs.some(([o, n]) => o === p || n === p);
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (inR(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of rPairs) rows.push({ key: n, line: `R ${o} -> ${n}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

# mend-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/padit8035-glitch/mend-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/padit8035-glitch/mend-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. Applies unified diffs (even when the line numbers are wrong), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor calls. It finds the lines you meant even when spacing or indentation has drifted, and it changes every file or none at all.

## Run it

```sh
# pipe a patch in on stdin
node main.ts < fix.patch

# or give it a patch file
node main.ts fix.patch

# check what would change, without writing anything
node main.ts --check fix.patch

# pick a format explicitly
node main.ts --format=v4a fix.patch
```

## How it works

- **Unified diff**: sections from `diff --git` / `---` + `+++` pairs, hunks matched by their content near the claimed line, creations, deletions, renames and moves.
- **SEARCH/REPLACE**: blocks bounded by `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`, with the file path from the line above the block (or the previous block).
- **V4A**: `*** Begin Patch` / `*** End Patch` with Add File, Delete File and Update File sections, chunk anchors and `*** Move to:`.
- **JSON**: an array of edits, or one edit per line — `create`, `str_replace` and `insert`.
- **Matching**: exact lines first, then lines that differ only in trailing whitespace, then lines that differ in leading and trailing whitespace (`--strict` turns the last two off).
- **Safety**: a path that escapes the working directory is refused (`unsafe`), a failed edit changes nothing, and every later edit still runs. One run reports one line per changed file (`A`/`D`/`M`/`R`), then `ok: n file(s)` — or `failed: k of n edits` with exit code 1.

## Score

Practice set from the official kit: **100 of 100 checks passed (score 1000)**, plus 20 extra edge-case tests of my own, and a full trial run against the kit's local env server: **100 of 100**.

---

<sub>Entered on [make.fun](https://make.fun/?ref=tvfbjxfd&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

# mend — one patch tool for every AI edit format

`mend` applies AI-written edits in four formats to a tree of files, to one written
specification (SPEC.md in the Makefun kit):

- unified diffs (often with wrong line numbers)
- SEARCH/REPLACE blocks
- V4A patches
- JSON text-editor tool calls

It finds the lines an edit names even when the model drifted their whitespace or
indentation (3-tier matching: exact, trailing whitespace, leading+trailing
whitespace), and changes every file or none.

Built for the Makefun bounty
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
— account @yahahayuk.

## Practice score

100/100 on the kit's practice set (score 1000):

- unified 30/30, SEARCH/REPLACE 20/20, V4A 20/20, JSON 15/15, CLI 15/15
- plus 45/45 hand-built edge cases

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- Working directory is the tree root; every patch path is relative to it.
- `PATCH` absent or `-` → patch read from stdin.
- `--format=NAME`: `unified`, `search-replace`, `v4a`, `json`, or `auto` (default).
- `--check`: everything but writing — same output and exit code, no file created,
  changed, or deleted.
- `--strict`: tier 0 matching only.

Exit codes: 0 = applied, 1 = an edit could not be applied (nothing written),
2 = usage / no-patch / format / parse error. Stdout holds only the result lines.

## Requirements

Node 22 and its standard library only. No dependencies, no installs.
Deterministic: the same check gives the same exit code, stdout, and files every run.

## Files

- `main.ts` — the CLI
- `runner.ts` — the kit's runner, unchanged
- `LICENSE` — MIT

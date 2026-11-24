# Yahaha

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/waduh512/Yahaha/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/waduh512/Yahaha/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It applies AI-written edits in four formats to a tree of files: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls. It finds the lines an edit names even when the model drifted their whitespace or indentation (3-tier matching: exact, trailing whitespace, leading+trailing whitespace), and changes every file or none. Practice score 100/100 on the kit's practice set (score 1000): unified 30/30, SEARCH/REPLACE 20/20, V4A 20/20, JSON 15/15, CLI 15/15, plus 45/45 hand-built edge cases. Node 22 and its standard library only — no dependencies, no installs. Deterministic: the same check gives the same exit code, stdout, and files every run.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=1m7wdtnj&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

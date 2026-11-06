# PR owner from the producing turn

Use the shared metadata-only isolated daemon setup in SKILL.md. The helper seeds
synthetic ledger rows and turns in its own database and needs no network.

```sh
bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/pr-owner-from-turns.ts
```

A PR whose URL is in a finished turn that covers its creation time gets that
session as owner. A PR in a turn that could not be read fully keeps its owner and
is not announced. A PR no turn produced is announced as unowned. Evidence is
`observed.json` and `proof.log`.

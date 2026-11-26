# Require completed plan steps and approval

Run the registered Neo operations against an isolated daemon from the repo root.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/todo-plan-wire.ts
```

The helper adds a plan through the public operation, tries to finish it without
steps or a check, and tries to remove, replace or detach its only step. The daemon
refuses the changes and still allows dropping the ask. No provider turn or HTTP
mock is needed. Keep the observed replies, proof log and wrapper exit status.

# Require completed plan steps and approval

Run the registered Neo operations against an isolated daemon from the repo root.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/todo-plan-wire.ts
```

The helper adds a plan through the public operation, tries to finish it without
steps or a check, and tries to remove, replace or detach its only step. It
supplies a recorded checker result as a fixture, signs off through the human
operation, and verifies that a smaller step list needs a new check and sign-off.
It checks cascade and removal-card refusals, including a quoted chat answer
retried with the same request ID. The chat message is accepted, the refusal
appears once in the conversation, and the card and last step stay open. The
helper then settles the finished plan's ask and drops an abandoned ask. No
provider turn or HTTP mock is needed.
Keep the observed replies, proof log and wrapper exit status. For the checker
delivery and report, run the [plan check journey](todo-plan-build.md).

# Build the plan check

Run from the current tree with the shared isolation setup in `../SKILL.md`.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/todo-plan-build.ts
```

The helper starts an isolated daemon and invokes its registered work, messaging
and question operations. It verifies that an unmarked todo cannot start a
checker. It marks a synthetic plan in storage, then observes the daemon's
checker delivery, refusal to record the wrong steps, recording of the correct
steps and opening of a sign-off card. The author role is a fixture. No model
turn runs. Keep `observed.json`, `proof.log` and the wrapper exit status.

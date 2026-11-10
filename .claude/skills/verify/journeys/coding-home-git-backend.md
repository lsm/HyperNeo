# Coding home Git backend composition

Read `../SKILL.md` and use the shared isolated proof wrapper.

```sh
bash .claude/skills/verify/proof-run.sh "$SUCCESS_EVIDENCE" \
  .claude/skills/verify/coding-home-git-backend.ts success
bash .claude/skills/verify/proof-run.sh "$UNCERTAIN_EVIDENCE" \
  .claude/skills/verify/coding-home-git-backend.ts uncertain
```

Each run owns HOME, a daemon DB, ephemeral ports, a refusing external HTTP guard,
a synthetic GitHub CLI and a local bare Git destination. No provider credentials,
real GitHub repository, live daemon or GUI is used. The CLI accepts only the
synthetic auth probe, owner lookup and exact private-create command.

Require exit 0 and `home-git-backend.json` with `verified=true`, one creation
attempt, a recorded bound human yes, `saveSerialized=true` and closed resources.

Both modes persist disabled coding guidance and restart before invoking the
actual home operations over authenticated `operation.invoke`. Missing/open
consent refuses creation. The local-human question answer authorizes the bound
private repository once. A blocked synthetic create holds a simultaneous home
save until publication releases, exercising the shared backend instance.

Success pushes the curated history to local Git and a restart reuses its receipt.
Uncertain publishes to the synthetic destination but returns failure before
configuring a local origin. Its creating receipt survives restart and refuses
another create attempt. The synthetic home save remains valid in both modes.

Inspect `home-gh.log` and the stored creation/save results. The wrapper retains
these artifacts and cleans disposable daemon data and repositories. The focused
home operation suites also retain consent rejection, conflict-choice, read,
clone and publication safety contracts through the moved implementation.

# Coding session target

Use the shared isolated daemon setup in `../SKILL.md`.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-session-target.ts
```

The helper starts an isolated daemon and records an earlier feature worker and
reservation. The coding pack leaves a new start and an explicit author send on
their requested targets. The todo runner dispatches the start and leaves the
old reservation unchanged. Retain `evidence/session-target.json`.

Use `coding-unresolved-threads.md` to verify review findings still reach the PR
owner through the sweep. Model-line ranking and saved write model and effort are
covered by the coding session target tests and stage preference journey.

# Coding actor exclusions

Use the shared isolated daemon setup in `../SKILL.md`.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-session-assignments.ts
```

The helper starts an isolated daemon, records a coding todo and review actor,
and reads the repository and actor exclusions through its database gateway.
Retain `evidence/session-assignments.json`.

# Coding session assignments

Use the shared isolated daemon setup in `../SKILL.md`.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-session-assignments.ts
```

The helper boots an isolated daemon twice on one synthetic database and calls
the session assignment store through the daemon's own DB gateway. Three
concurrent reservations of one repo feature agree on a single owner todo, a
retry by that todo recovers its own reservation, and after a restart a later
todo of the feature resolves to the owner's recorded session. A per-task lookup
for that later todo finds nothing, so it does not inherit the feature session.

Coding dispatch does not read assignments yet, so this journey does not claim
that any worker was reused or started.

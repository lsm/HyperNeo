# Coding session strategy

Use the shared isolated daemon setup in `../SKILL.md`.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-session-strategy.ts
```

The helper reads and saves the repo-scoped `sessionStrategy` setting through
authenticated WebSocket RPC, rejects a value outside `long_lived`, `per_task`
and `per_pr`, and checks human provenance after a restart. An unanswered repo
plans as `long_lived` without saving a value.

It calls the session dispatch planner directly with the saved strategy: with
every session busy, `long_lived` starts a work-type-named session and `per_pr`
starts a session of its own. Coding dispatch does not call the planner yet, so
this journey does not claim that any worker was reused or started.

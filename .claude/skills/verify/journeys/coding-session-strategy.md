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
starts a session of its own. The `coding-session-target.md` journey exercises
the resulting dispatch through the coding hook and the real daemon driver.

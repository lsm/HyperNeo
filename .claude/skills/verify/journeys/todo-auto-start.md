**An added todo with met prerequisites starts with no Start card.**

Use SKILL.md isolation; no provider or model is used. Worker transport is a synthetic Codex socket.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence .claude/skills/verify/todo-auto-start.ts verify
```

Through the real daemon, the agent MCP door and public RPC:

- `neo.ask.open` adds a three-step chain to the historical accepted ask without a start flag or new card. The first step dispatches; the others stay `todo`.
- Holding a check-only step opens its Start/Remove card. That step and an unapproved todo stay held after an unrelated card on the same ask is answered.
- Each finished step dispatches the next one once, and only the held step's card stays open.

Evidence is `observed.json` and `proof.log`. The unit test `neo-todo-auto-start.test.ts` pins that a fill overlapping a stop admits nothing over a limit.

The helper seeds an accepted historical ask for its unrelated work fixture.
Use new-work-source.md for the real proposal and human-approval path.

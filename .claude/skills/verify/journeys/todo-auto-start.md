**An added todo with met prerequisites starts with no Start card.**

Use SKILL.md isolation; no provider or model is used. Worker transport is a synthetic Codex socket.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence .claude/skills/verify/todo-auto-start.ts verify
```

Through the real daemon, the agent MCP door and public RPC:

- `neo.ask.open` with a three-step chain and no start flag opens no card. The first step dispatches; the others stay `todo`.
- Holding a check-only step opens its Start/Remove card. Answering an unrelated card on the same ask keeps that hold card open; neither the held step nor an unapproved todo starts.
- Each finished step dispatches the next one once. Only the original hold card remains open, covering the held step alone.

Evidence is `observed.json` and `proof.log`. The unit test `neo-todo-auto-start.test.ts` pins that a fill overlapping a stop admits nothing over a limit.

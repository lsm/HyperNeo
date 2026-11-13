**An added todo with met prerequisites starts with no Start card.**

Use SKILL.md isolation; no provider or model is used. Worker transport is a synthetic Codex socket.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence .claude/skills/verify/todo-auto-start.ts verify
```

Through the real daemon, the agent MCP door and public RPC:

- `neo.ask.open` with a three-step chain and no start flag opens no card. The first step dispatches; the others stay `todo`.
- A held check-only step and a todo still on an old Start card stay held after an unrelated card on the same ask is answered.
- Each finished step dispatches the next one once, and the Start card is the only card left open.

Evidence is `observed.json` and `proof.log`. The unit test `neo-todo-auto-start.test.ts` pins that a fill overlapping a stop admits nothing over a limit.

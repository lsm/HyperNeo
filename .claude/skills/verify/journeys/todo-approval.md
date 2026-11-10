# One Start answer runs an approved chain

Use SKILL.md isolation; no provider or model is used. Worker transport is a synthetic Codex socket.
```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence .claude/skills/verify/todo-approval-proof.ts verify
```
Through the real daemon, MCP handler and public RPC, require: one Start answer approves a three-step chain and each public todo records the card id, an independently start:true todo records no card id, the steps dispatch once each in order with no second card, a held step stays held, a removed prerequisite stops its dependent with no card, `after` edits are refused, and `neo.todo.proceed` then dispatches the dependent once.

For approval source alone, append `--approval-source-only` to the command. The isolated public reader must show the Start card id for a ticked todo and null for a `start:true` todo.

# One Start answer runs an approved chain

Use SKILL.md isolation; no provider or model is used. Worker transport is a synthetic Codex socket.
```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence .claude/skills/verify/todo-approval-proof.ts verify
```
Through the real daemon, MCP handler and public RPC, require: one Start answer approves a three-step chain, the steps dispatch once each in order with no second card, a held step stays held, a removed prerequisite stops its dependent with exactly one card, `after` edits are refused, and approval then dispatches the dependent once.

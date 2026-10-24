# Neo work must name a todo of an open ask

Use the shared in-process setup in SKILL.md with pinned Bun, fresh synthetic
HOME/data/DB and `PROOF=.claude/skills/verify/work-todo-reference.ts`. No provider,
model mock, real key, GUI or HTTP mock ports are needed. The helper owns an
ephemeral non-8399 daemon and closes it in finally.

The production Neo MCP operation handler must refuse work.send with no todoId,
an unknown todo or a todo belonging to a closed ask. An id in message text and a
forged input source do not satisfy admission. work.start without a todo must
likewise refuse before creating work. The same real HyperNeo worker accepts a
follow-up naming an open-ask todo, and trusted internal daemon dispatch remains
accepted without a todo reference. Retain evidence/result.json and the daemon
log; the baseline accepts untracked sends and this helper fails.

Also run the existing dispatch-evidence.ts journey in its own fresh isolated
environment. Its actual todo runner, synthetic Codex peer and CLI inbox must
still accept opening work and follow-ups across restart. This proves operation
admission and durable transport acceptance, not provider/model receipt.

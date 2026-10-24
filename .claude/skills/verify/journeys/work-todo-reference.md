# Neo work must name a todo of an open ask

Use the shared in-process setup in SKILL.md with pinned Bun, fresh synthetic
HOME/data/DB and `PROOF=.claude/skills/verify/work-todo-reference.ts`. No provider,
model mock, real key, GUI or HTTP mock ports are needed. The helper owns an
ephemeral non-8399 daemon and closes it in finally.

The production Neo MCP operation handler must refuse work.send with no todoId,
an unknown todo, a todo belonging to a closed ask, or one owned by another coordinator’s ask. An id in message text and a
forged input source do not satisfy admission. work.start without a todo must
likewise refuse before creating work. work.queue must refuse untracked next-turn input too. The same real HyperNeo worker accepts a
follow-up naming an open-ask todo, and trusted internal daemon dispatch remains
accepted without a todo reference. Retain evidence/result.json and the daemon
log; the baseline accepts untracked sends and this helper fails.

The same helper invokes neo.todo.add with start:true and neo.todo.continue through
the production MCP door. Its actual todo runner must create a doing todo and
accept the follow-up through the local worker adapter without an explicit todoId
on its internal work call. This proves operation admission and durable transport
acceptance, not provider/model receipt or external Desktop harness behavior.

# Missing todo references are recorded while work is delivered

Use the shared isolated setup in SKILL.md. No provider, real key, GUI or external
network is needed. Set TMPDIR=/private/tmp for these helpers.

For the production MCP handler, HyperNeo adapter and durable mailbox boundary:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/work-todo-records.ts
```

Eight work.send/work.queue calls with missing, unknown, closed-ask or foreign
references must return ok true and a todo_required record. A valid owned todo
returns no bookkeeping record. All nine accepted messages must reach the real
mailbox repository, retain their sender and target, and survive reopening the
migrated database. Four explicit queues retain deferred delivery semantics. All eight accepted bookkeeping audit records also survive database reopen.
Run the same helper on the regression commit: it fails at the first missing
reference with ok false/todo_required. Keep observed.json and proof.log; the
shared wrapper saves evidence and deletes disposable data.

This proves tool-visible receipts and durable transport acceptance. It does not
prove provider execution, external Desktop behavior, HTTP/WebSocket or web UI.

For the full daemon and actual todo runner, use the shared in-process setup with
PROOF=.claude/skills/verify/work-todo-reference.ts. Its production MCP calls must
accept missing, unknown, closed-ask and foreign todo references with records.
A forged input source or an id only in message prose still produces the record.
work.start likewise accepts otherwise permitted work with a record. An owned
open todo and trusted internal dispatch remain accepted. neo.todo.add start:true
and neo.todo.continue must dispatch through the actual runner and local worker
adapter. The helper owns an ephemeral non-8399 daemon and closes it in finally.

If the host denies a listener, retain proof.log and mark full-daemon verification
blocked; the listener-free mailbox proof above is a narrower result. Do not
change host permissions. The focused work-reference tests also cover start,
explicit queue/steer, remote records, RPC receipts and unsupported delivery.

# Activate shared worker-stop reads (#8712 core 4b)

Use SKILL.md's guarded metadata-only wrapper, existing dependencies and a fresh
absolute evidence directory:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/todo-stop-context.ts verify
```

This calls the real public `neo.todo.close` and `neo.todo.remove` operations
over WebSocket, with reader/writer workers and full `neo.ask.read` Work cards.
Only `work.stop` uses a scripted operation boundary; no real provider, worker
process, Desktop app, external GitHub request or GUI is exercised. Before the
fix the public close fails on main-thread stop-context SQL.

Both operations must retain the entire Unicode report in their receipts and
public cards. A thrown stop or driver refusal must leave the card unchanged;
unsupported remains a successful no-op. An adopted worker must never receive
a stop. A replacement committed before the context read must receive the stop
instead of the prior worker. A valid replacement todo stays linked; one deleted
during stop produces replacement_missing without a stale link. A full report
written concurrently during that stop survives the receipt and opened card. An
already-settled ask must return unchanged, successful no-op receipts without
any stop.

The scripted stop opens and rolls back a main connection transaction and
awaits a writer-lane status update. Both must finish before close/remove commits,
proving driver effects do not occupy a transaction. Trace stop-context SQL
on main and require zero. A human card arriving during stop must still refuse
close after the stop returns. The #9072 policy must retain open-question and
pending-answer needs-human holds, releasing a retired card with no pending
answer. This activation does not move ask settlement. The removal completion audit
for #9002 is in neo-todo-remove-writer.md.

Focused stop-context tests additionally cover stale caller states in both
directions, missing current todos, current adoption, operation errors and
throws. Run existing runner, runner activation and mutation operation suites
unchanged, then the full check. Required Deno smoke repeats this same proof;
label local Deno unverified when unavailable.

The helper closes its transport and daemon in finally and writes
`todo-stop-context.json`. The wrapper saves evidence before deleting the
synthetic HOME/data. No contention latency-target pass is claimed.

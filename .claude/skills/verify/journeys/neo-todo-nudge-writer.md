# Idle reminder admission reserves its writer slot before delivery

Use the shared metadata-only setup and disk/cleanup wrapper in SKILL.md:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/todo-nudge-writer.ts verify
```

`EVIDENCE` is a fresh absolute directory outside the disposable daemon run.
The helper owns an ephemeral daemon, two manual synthetic sessions and its
GitHub stub. No provider, model turn, GUI, live data or port 8399 is involved.

The real scheduled refresh sees an idle stopped worker that cannot receive
messages. Refusing admission with a trigger must send no reminder or notice.
After removing the trigger, the reminder's failed delivery must escalate once;
repeated refreshes stay quiet and the real WebSocket snapshot keeps the card
doing. Main instrumentation must see zero reminder bookkeeping queries.
Two actual writer claims must reserve one reminder only, and late completion
must preserve a newer activity incident. Runner tests retain successful
delivery at 20/40 minutes and escalation at 60, pack waiting and adopted cards.

The helper holds a synthetic WAL writer lock for 1.2 seconds. Admission waits,
but real `system.health` must respond below 250 ms and loop lag stay below 1 s.
The affected write still fails the 250 ms latency target: report it explicitly.
This contention phase drives the command boundary directly; preceding phases
use the real scheduled job and snapshot. Queue, SQL and clone stages are not
separately attributed.

On the test-first pre-fix commit in the same checkout use `before` and another
evidence directory. It records reminder SQL on main and health stalled over 1 s.
The wrapper saves JSON and logs before deleting each run's temporary daemon data.
The failing runner reproductions show duplicate reminders during a pending send
and loss of newer activity when an old delivery completes.

Run the runner, todo-gateway and settlement tests, source types and repository
checks. Deno smoke verifies the actual worker admission and completion path.

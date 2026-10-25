# Needs-you notification admission runs in the DB writer

Use the shared metadata-only setup and disk/cleanup wrapper in SKILL.md:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/todo-needs-you-writer.ts verify
```

`EVIDENCE` is a fresh absolute directory outside the disposable daemon run.
The helper owns an ephemeral daemon, two manual synthetic sessions and its
GitHub stub. No provider, model turn, GUI, live data or port 8399 is involved.

The real scheduled Neo refresh sees a worker waiting for the human. A trigger
refuses its incident mark: no notification may be queued. After removing the
trigger, the refresh must commit the mark and enqueue one ask-the-human note;
another refresh must stay quiet. The real WebSocket `neo.snapshot` keeps the
followed card. Main instrumentation must see no needs-you incident reads/writes
during the successful refreshes. Two concurrent real worker claims must admit
one notification only.

The helper then holds a synthetic WAL writer lock for 1.2 seconds. The writer
claim waits, but real `system.health` must respond below 250 ms and loop lag
must stay below 1 s. The affected write still exceeds 250 ms: report that
latency failure explicitly. This last phase drives the command boundary
directly; the earlier phases use the scheduled job and snapshot.

On the test-first pre-fix commit, use the same checkout with `before` instead
of `verify`, saving to another evidence directory. It records main SQL and a
health stall over 1 s for the original synchronous claim. The wrapper saves
JSON and logs and deletes each run's temporary daemon data immediately.

Run the todo-gateway and runner tests for single-winner admission, missing and
ineligible cards, persistence refusal, repeated incidents, worker-blocked cards
and notification ordering. The Deno smoke exercises the same writer command.
This slice does not move idle-reminder admission; that is the next slice.

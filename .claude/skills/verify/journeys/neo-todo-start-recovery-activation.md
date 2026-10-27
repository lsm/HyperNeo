# Activate atomic interrupted-start recovery (#8712 core 3b)

Use SKILL.md's resource guard and guarded metadata-only wrapper with existing
dependencies and a fresh absolute evidence directory:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/todo-start-recovery-activation.ts verify
```

This journey calls the actual runner refresh path with the isolated daemon's
writer worker. Complete Work cards are read through the real `neo.ask.read`
WebSocket operation. Before activation, an injected failed recovery leaves the
interruption flag set even though the card change rolls back; the red proof
fails on that incorrect retry prohibition.

After activation, failed recovery must preserve the flag and card together and
send no notice or table notification. Hold a WAL lock: refresh cannot return
success or emit effects before commit, while health and card reads still
answer. Release it: the failed Work card must retain its full Unicode report,
and the runner must announce exactly one committed change and one recovery
notice. Repeated refreshes stay quiet. The real `neo.todo.retry` operation must
warn `start_uncertain` only after successful recovery.

Seed a stale candidate whose worker has since bound: recovery must retain its
doing state without an interrupted flag or recovery notice. Only work.status
may reach the scripted driver; recovery must never dispatch a worker. Trace
main SQL from candidate discovery until each recovery writer receipt returns;
later worker observation and the rest of refresh remain outside this slice's
SQL claim.

Run the existing in-flight-start recovery guard regression unchanged. It holds
a committed claim's return while refresh runs and requires the start to remain
doing without an interruption flag. The activation must keep the starting
Set check outside the writer; no database-only predicate replaces it. Other
runner controls retain completed, blocked, removed and late-bound decisions.

Run focused runner/recovery/state suites and the full check. The required Deno
smoke executes the same helper; label local Deno unverified if unavailable.
The helper closes its daemon and transport in finally, writes
`todo-start-recovery-activation.json`, and the wrapper saves evidence before
removing temporary synthetic HOME/data. No live daemon, real provider, browser,
real worker dispatch or latency-target pass is claimed.

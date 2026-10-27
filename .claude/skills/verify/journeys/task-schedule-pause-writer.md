# Pausing a task schedule awaits its DB writer

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/schedule-pause-evidence \
  .claude/skills/verify/task-schedule-pause-writer.ts verify
```

The helper starts a fresh synthetic daemon with an ephemeral listener and no
credentials. Through real WebSocket RPC it creates future one-shot and cron
task schedules, pauses them, and reads the paused results back. Each pending
fire job must disappear. Schedule identity, timing, complete Unicode description,
priority and ordered labels survive. Wrong-Space, missing and already-paused
requests must fail without altering the schedule or its job.
An injected SQL failure during the pause must roll back its paired job deletion
and return an RPC error while the original active schedule stays intact.

The main connection must prepare neither the pause UPDATE nor its paired job
DELETE. Commit the baseline reproduction before fixing the RPC: all behavior
checks pass, then the SQL assertion fails. Repeat with
`VERIFY_PROOF_RUNTIME=deno` and supported Deno on PATH. The wrapper preserves
RPC replies and captured SQL and cleans up the isolated daemon data.

Run schedule-service and task-schedule-handler unit suites for lifecycle and
pending-job compare-and-swap behavior. This proof covers the taskSchedule.pause
RPC only. Goal automation callers, other schedule lifecycle operations, real
schedule firing and held-writer latency remain separate migration surfaces.

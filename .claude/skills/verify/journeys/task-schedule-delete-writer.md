# Deleting a task schedule commits with its pending job

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/schedule-delete-evidence \
  .claude/skills/verify/task-schedule-delete-writer.ts verify
```

Through a fresh synthetic daemon's real WebSocket RPC, the helper creates future
one-shot and cron schedules and deletes them. Both schedules and their pending
fire jobs must disappear. Wrong-Space and missing requests must fail, preserving
the other Space's schedule/job. A SQL trigger then rejects a schedule deletion:
the RPC must fail and both the original active schedule and its pending job
must survive together.

Commit this failing reproduction before the fix. The baseline loses the pending
job when deletion fails; the writer transaction must roll it back. Main-connection
instrumentation must also capture zero schedule/job DELETEs during the RPCs.
Repeat under supported Deno with VERIFY_PROOF_RUNTIME=deno. The wrapper preserves
RPC replies and captured SQL and removes its isolated daemon data.

Run schedule-service, task-schedule-repository and fire-handler suites for existing
pending-job comparison and lifecycle behavior. This covers taskSchedule.delete
only; goal schedule callers, other lifecycle writes, real schedule firing and
held-writer latency remain separate surfaces. No model turn or script executes.

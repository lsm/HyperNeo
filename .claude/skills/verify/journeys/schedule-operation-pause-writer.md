# The schedule operation awaits its pause writer

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/operation-pause-evidence \
  .claude/skills/verify/schedule-operation-pause-writer.ts verify
```

The helper starts a fresh synthetic daemon, creates one-shot and cron schedules,
and invokes schedule.update with status paused through real operation.invoke
WebSocket RPC. The returned and persisted schedules must be paused with their
pending jobs deleted and all metadata preserved. Repeating the desired status is
accepted without changes. Wrong-Space and missing targets return typed rejections.
An injected SQL pause failure must return rejected and retain the active schedule
and its pending job together.

Commit the failing baseline before wiring: the operation still uses the legacy
synchronous pause path, so its failure loses the pending job. The fixed common
operation must await the existing writer and run no target UPDATE/DELETE on the
main connection. Audit callbacks remain on main after the writer reply; no
callback is passed into the transaction. Repeat under supported Deno with
VERIFY_PROOF_RUNTIME=deno; the wrapper preserves replies and SQL and cleans up.

Run schedule-operations and schedule-service suites for caller admission, no-op,
audit and error behavior. This covers the RPC door to the common operation;
MCP transport, real agent turns, resume/create/delete and goal callers remain
separate surfaces. No real schedule firing or held-writer latency is claimed.

# Workflow snapshot migrations use the writer

The command accepts only a prepared version payload and identifiers. Both the
job proof and production startup migration use it; template resolver callbacks
remain on main, outside the writer transaction.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/snapshot-evidence \
  .claude/skills/verify/workflow-snapshot-writer.ts verify
```

A fresh synthetic daemon creates a legacy pinned run and then changes the live
workflow. Its real persisted job processor runs a fixture job which invokes the
new writer command. The job must complete, and `spaceWorkflowRun.listHookStates`
over the actual WebSocket must return the frozen hooks, not the edited live
workflow's hooks. The full Unicode definition and its SHA-256 hash must survive.
Main-connection instrumentation records zero definition-version or pin-update SQL
while the job runs. Evidence retains the terminal job record and RPC reply.

After the job and contention phases, the helper seeds another snapshot-less
pin, closes the daemon and restarts against that synthetic database. Production
RPC setup must finish migration before serving `spaceWorkflowRun.listHookStates`;
the reply must retain the frozen hooks despite the edited live definition.
Instrumentation during startup migration must record zero version INSERTs and
pin UPDATEs on main. Evidence includes `startupSql` and the recovered pin.

The wiring regression commit completes the job proof but fails this startup SQL
assertion. The earlier build contract instead ended dead with
`workflow.run.pin.write does not run migrateSnapshot`. Repeat with
`VERIFY_PROOF_RUNTIME=deno` and supported Deno on PATH for the second runtime.
The wrapper preserves evidence and removes its temporary database and home.

The workflow-run-pin-write unit cases cover preservation of ordinary pin
admission, snapshot replacement, transaction rollback, and notifications only
after successful commit. This fixture proves the command through a real job/RPC surface and production
startup migration. Other workflow reads/writes, worker death, model turns and
GUI layout remain separate verification surfaces.

A second phase holds a writer lock on the same synthetic WAL database in a
separate Bun child for 1.2 seconds. The snapshot command must wait, while the real
`system.health` RPC stays below 250 ms and measured main-loop lag below 1 second.
The affected write necessarily exceeds the 250 ms latency goal under that lock;
the evidence records this limitation rather than treating it as a full latency
pass. The child opens only the disposable synthetic database and inherits the
wrapper's scrubbed environment. Both runtime proofs require Bun for this lock
fixture. The helper saves health/write timing, max loop lag, payload bytes and
RSS; worker SQL/queue/clone timing and worker-death injection remain unverified.

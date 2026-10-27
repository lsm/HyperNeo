# A direct-outcome retry parks through the fenced DB writer

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/outcome-parking-evidence \
  .claude/skills/verify/direct-outcome-parking-writer.ts verify
```

The helper boots a fresh synthetic daemon and creates a running direct-task
attempt whose worker runtime is absent. It uses the production durable-outcome
requester and the daemon's already-registered direct-outcome job handler. With
stop verification unavailable, that real job must return to pending with one
park and zero retries spent. Its task and attempt stay running and its durable
stop request survives.

The helper then gives the job a replacement claim. Calling the same production
handler with the old claim must leave the new owner processing, without adding
a park or reporting successful parking. The current owner may park normally.
Main-connection instrumentation must capture zero parking UPDATE statements.
The baseline runs all these behavior checks but fails the final SQL assertion;
that failing reproduction is committed before the wiring change.

Repeat with `VERIFY_PROOF_RUNTIME=deno` and supported Deno on PATH. Evidence
includes persisted job states and both stale/current handler outcomes. The
shared wrapper isolates homes, preserves evidence and cleans up daemon data.
No model turn, real worker process, live DB or fixed port is used.

Run the direct-outcome-jobs and job-queue-repository unit files to retain park
budgets, the fixed park window, shutdown retry behavior and claim fencing.
This proves the production parking branch; outcome admission/finalization SQL,
other direct-task writes, worker-death injection and held-lock latency remain
separate migration surfaces.

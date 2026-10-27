# Build the fenced job requeue writer family

This build slice makes existing requeue methods available to the writer command
catalog. Production direct-start and outcome callers switch in later wiring
slices; this does not claim those paths have already left main.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/requeue-evidence \
  .claude/skills/verify/job-requeue-writer.ts verify
```

A fresh isolated daemon claims a synthetic target job. Its real job processor
runs a persisted control job that parks the target, claims it again, waits,
claims it again, then requeues it. Every operation rejects the previous claim's
token before accepting the current claim. Parking records its budget metadata;
waiting clears that metadata. No retry is spent and the full Unicode payload
survives. Main-connection instrumentation records zero target requeue UPDATEs.
Evidence includes the control job's terminal result and captured SQL.

The same contract before the build ends dead with `jobs.write does not run
requeueParked`. The failing contract is committed before the catalog change.
Repeat with `VERIFY_PROOF_RUNTIME=deno` and the supported Deno on PATH. The
shared wrapper scrubs the environment, saves evidence and removes synthetic
daemon data after cleanup.

Run the existing job-queue-repository unit cases for requeue, stale-token fencing,
park metadata and waiting semantics. This journey proves command availability
through a real daemon job; production task integration, worker-death injection,
held-lock latency, RPC presentation and GUI behavior remain separate surfaces.

# Direct-start deferrals use the fenced DB writer

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/direct-start-evidence \
  .claude/skills/verify/direct-start-requeue-writer.ts verify
```

The helper starts a fresh synthetic daemon and uses its production durable
direct-start requester. Pausing the Space after admission makes the daemon's
already-registered start handler defer its job. The job returns to pending,
spends one park and zero retries, and retains its reserved attempt and open task.
No session is loaded and no model turn runs.

For capacity and dependency deferrals, the helper supplies those start-result
fixtures to the production handler on the real job processor. Waiting clears
park counters without spending retries. Old claim tokens must fail both the
waiting and parking branches without changing a replacement claim. The owned
claim may wait, and the complete frozen Unicode start note survives.

Main-connection instrumentation must record zero parking or waiting UPDATEs.
The baseline completes the behavioral checks but fails that SQL assertion;
commit the failing reproduction before changing the handler. Repeat with
`VERIFY_PROOF_RUNTIME=deno` and supported Deno on PATH. The wrapper preserves
job states and handler results, then removes its isolated daemon data.

Run direct-start-jobs and job-queue-repository unit suites for capacity admission,
park budgets, lifecycle races and claim fencing. The capacity/dependency proof
fixtures do not establish real worker preparation or activation. Admission,
activation, cleanup, other task SQL and held-lock latency remain separate work.

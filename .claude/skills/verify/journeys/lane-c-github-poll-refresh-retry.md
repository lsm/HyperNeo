# Retry a settings refresh after writer failure

Run lane-c-github-poll-refresh-retry.ts with Bun and Deno in a fresh synthetic
run under env -i, NODE_ENV=test, disposable HOME/data and an ephemeral daemon.
The helper asserts data-dir isolation and absent credential environment variables.
It stubs provider availability/credential responses in memory solely to enter the
real app GitHub-service branch; model discovery returns empty and external HTTP is
refused. Nothing is loaded from a real credential store, enrolled in the process
environment, sent to a provider or used for a model turn. No GitHub token is used.
Restore these owned-process stubs after closing the daemon. Actual authentication
and provider bootstrap are not proved by this synthetic auth gate.

Stop/drain the owned processors and seed one pending poll job plus a foreign job.
Intercept the first refresh writer request with a rejected promise, without
running it. Real settings.global.update RPCs publish to the actual production app
subscription; there is no test bridge for this journey. The first disable must
leave the pending job, log one failure and not replay automatically. Repeating the
same disable through RPC must retry and delete the pending job. A third identical
update must perform no new admission after success is memoized. The foreign job
is retained and main refuses target job SQL throughout. Health RPCs bracket the
path. Baseline records one swallowed attempt, no warning and the pending job after
the second update. Fixed proofs record exactly two attempts, one warning and no
pending poll job. Save evidence/github-poll-refresh-retry.json before deleting the
owned run. Real GitHub, worker death, UI and contention remain unverified.

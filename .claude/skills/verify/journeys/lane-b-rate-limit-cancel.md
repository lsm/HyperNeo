# Rate-limit cancellation commits before its RPC returns

Run `lane-b-rate-limit-cancel.ts` with Bun or Deno in a fresh synthetic run under
`env -i`, with NODE_ENV=test, HOME=<run>/home and HYPERNEO_DATA_DIR=<run>/data.
The helper creates its own ephemeral daemon and manual session through real RPC;
no provider, model, HTTP mock or GUI is required. It stops its own job processor,
seeds two future delivery jobs and enqueued inputs, and persists an owning cooldown.

The real session.cancelRateLimitRetry RPC must delete the owning delivery, mark
its message failed, release the next delivery without spending a retry, and clear
the cooldown before returning. Public message.status reports failed for the owning
input and queued for the next one. The main connection rejects target cancellation
SQL. The baseline must fail with one forbidden main write and an unsettled episode.

Evidence is evidence/rate-limit-cancel.json. The helper closes its own transport
and daemon and removes temporary home, workspace and data after saving evidence.
This journey does not exercise a provider turn, other cancellation paths, reclaim,
manual retry, shutdown recovery, or performance and contention targets.

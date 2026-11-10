# Rate-limit cancellation commits before its RPC returns

Run `lane-b-rate-limit-cancel.ts` with Bun in a fresh synthetic run under `env -i`, with
NODE_ENV=test, HOME=<run>/home and HYPERNEO_DATA_DIR=<run>/data. The helper creates its
own ephemeral daemon and manual session through real RPC; no provider, model, HTTP mock or
GUI is required. It stops its own job processor, seeds two future delivery jobs and
enqueued inputs, and persists an owning cooldown.

The real session.cancelRateLimitRetry RPC must delete the owning delivery, mark
its message failed, release the next delivery without spending a retry, and clear
the cooldown before returning. Public message.status reports failed for the owning
input and queued for the next one. The main connection rejects target cancellation
SQL. The baseline must fail with one forbidden main write and an unsettled episode.

Evidence is evidence/rate-limit-cancel.json. The helper closes its own transport
and daemon and removes temporary home, workspace and data after saving evidence.
Unit tests hold the writer boundary before fallback-owner lookup, reject a writer
failure without inline fallback, and inject a settlement error to prove the job
deletion rolls back. They retain consumed status, other-session isolation and
idempotent notification, reject a released claim's old heartbeat, and delay
publication and cooldown clearing to check their ordering outside the transaction.

This journey does not exercise a provider turn, other cancellation paths, reclaim,
manual retry, shutdown recovery, or performance and contention targets.

The same RPC proof seeds each in-memory recovery hold on the real session's
watchdog: fallback pending, billing pause, startup exhaustion and retry callback
in flight. Each begins in processing rather than rate_limit_cooldown. Manual
cancellation must return with the session idle. This simulates recovery flags;
no provider failure or live stuck session is reproduced.

A retry callback with a pending user question must retain waiting_for_input and
the pendingQuestion after cancellation. Unit coverage also raises the question
during asynchronous delivery settlement to ensure the final clear respects it.

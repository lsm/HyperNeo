# Persisted rate-limit retry releases deliveries on the writer

Run `lane-b-rate-limit-retry.ts` with Bun or Deno under a scrubbed environment,
NODE_ENV=test, HOME=<run>/home and HYPERNEO_DATA_DIR=<run>/data. Use a fresh run.
No provider, model, HTTP mock, UI, real credentials or live restart is needed.

The helper seeds one synthetic manual session through the database facade,
closes the fixture writer, and starts a real daemon on an ephemeral non-8399
port. Loading that persisted session arms the real cooldown watchdog. After
stopping its own job processor, it seeds a claimed delivery, a later input and
an unrelated session delivery. A main-connection guard rejects all job UPDATEs
during the real WebSocket `session.retryNowAfterRateLimit` request.

The RPC must clear the persisted cooldown before replying, release both session
deliveries, remove the old claim, keep retry counts and the unrelated delivery,
and reject the old heartbeat. Baseline evidence must show a forbidden main write
and failed retry. Save evidence/rate-limit-retry.json before removing temporary
data. The helper closes its transport, daemon and seed database in finally.

Focused tests hold the runtime clear callback outside any transaction, restore
a cooldown while the writer is queued, remove the session before release, and
abort a later job update to prove all releases roll back. A failed writer must
return failure without replaying the job update on main. The writer reuses the
existing session and job repositories; only its boolean result crosses back.

This proves metadata behavior only. It does not exercise a provider turn, other
retry paths, contention, large payloads, worker death or latency targets.

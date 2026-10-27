# Transcript shutdown markers follow insertion order

Run `lane-b-transcript-shutdown-order.ts` through `proof-run.sh` in a fresh
synthetic source daemon. Run the same helper with the cached Deno runtime for
the native-worker smoke. It needs no provider turn, model mock or external HTTP.

Use SKILL.md's shared `waitForSdkBodyCopy` setup after fixture seeding, before
capturing body hashes or acquiring the competing writer. This keeps startup
migration outside the reader measurement without bypassing its real work.

Deterministic database IDs deliberately disagree with insertion order. Complete
split bodies and production-derived columns are seeded with normalized
replacement metadata. Actual `message.sdkMessages` WebSocket RPCs must remove
stale shutdown markers before the limit, preserve the true tail, select the last
of two tied shutdown markers and agree with before/since rowid cursors. Queued
users, nested messages and other sessions cannot supersede a top-level marker;
consumed and failed users can.

A proxy installed before daemon startup denies target statements at execution,
including cached main statements. Cold and concurrent warm RPCs execute while a
separate WAL writer holds an explicit transaction: outside/inside fixture values
must remain 0/1 before and after. Health remains usable. A reader failure rejects
the affected RPC and a later request recovers without restoring an actor or
falling back to main. Stored body hashes must remain unchanged and complete text
must survive the reply.

Before changing production code, retain failing unit tests and baseline daemon
evidence showing the wrong visible UUIDs with zero main SQL. The helper saves
the observed correctness checks, latency, worker queue/execution/delivery timing,
reply encoding size/time, loop lag, RSS and WAL size. Delivery timing combines
worker reply cloning and scheduling; it does not isolate either cost. Worker
execution includes SQL and assembly, not a separate SQL-only measurement.
The wrapper saves JSON/log/status and removes the synthetic daemon data after
cleanup. Source proof does not establish live deployment or browser UI smoke.

# Build Bun parity for a held-writer job claim

Use the shared isolation/resource setup in ../SKILL.md with pinned Bun 1.4.2.

    VERIFY_PROOF_RUNTIME=bun bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence scripts/bun-claim-lock-probe.ts

Commit the unavailable-probe regression before construction. The probe owns a
fresh DatabaseCore, waits for actual startup body copying and warms the native
gateway writer with an empty dequeue. It seeds one synthetic pending job and
uses the existing spawn-fixture-writer.ts worker with its release barrier.

The legacy fixture releases a timed lock around fixture insertion. This probe
seeds before locking and holds the lock through the gateway claim, using the
barrier to make claim contention deterministic. Require readiness, then a real
SQLite lock check from another connection. The claim must stay pending for the
200 ms observation and its job row must still be pending. Release the barrier,
require the holder's committed reply and counter value one, then the complete
claim payload/token and an empty second dequeue.

Require startupBodyCopyComplete, holderReady, lockOwned, claimWaitedForRelease,
holderCommitted, singleClaimPayload, holderTerminated, gatewayClosed,
databaseClosed and pass in bun-claim-lock.json, with wrapper exit zero. The
holder replies after closing its connection. Cleanup releases the barrier and
terminates the holder before closing the gateway and database. Preserve evidence
and inspect logs for database-close errors before the wrapper removes data.

The native regression preloads tests/unit/fixtures/bun-claim-unheld.mjs from the
daemon package. It makes the real fixture worker signal ready while waiting
without a write lock. Require exit one with the lock-ownership assertion, pass
false and holder/gateway/database cleanup flags. The existing-data refusal
must preserve its marker and create no database. No listener, provider, model,
existing database or live daemon participates.

This construction uses existing schema, SQLite, gateway and fixture modules. Its
bounded claims cover native lock ownership and job receipts. The Bun native entry
point calls this probe through proof-run.sh before todo incidents. Its failure must
retain status/evidence and suppress the runner success marker. The runner fixture
checks its failure and temporary-data cleanup.

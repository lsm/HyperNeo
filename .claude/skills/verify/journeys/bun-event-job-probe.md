# Build Bun parity for inline event and job receipts

Use the isolation/resource setup in ../SKILL.md with pinned Bun 1.4.2:

    VERIFY_PROOF_RUNTIME=bun bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence scripts/bun-event-job-probe.ts

Commit the unavailable-probe regression before construction. This standalone
probe initializes a fresh file-backed DatabaseCore, waits for actual SDK body
copy completion, then uses the native DbGateway without an inline connection.
It starts no listener, model, GitHub process or live daemon. Fixtures contain
synthetic event/feed/job values only; no existing database or credentials enter
the run. Existing-data refusal must preserve its marker and create no database.

Require the duplicate event receipt to return the original event ID. Purging the
Claude feed must retain exactly the Codex row with its complete body. Cleanup
must delete both an eight-day-old completed job and a two-hour-old completed
reminder under their separate cutoffs, retaining the failed reminder's full
payload. Dequeue must return one claim token and the full payload, followed by
an empty second dequeue.

Require startupBodyCopyComplete, duplicateEventIdentity, retainedFeedBody,
cleanupCutoffs, retainedJobPayload, singleClaimPayload, gatewayClosed,
databaseClosed and pass in bun-event-job.json, with wrapper exit zero. Inspect
the retained log for database-close errors; a flag before a cleanup failure is
not a pass. Close the gateway before the database and let the wrapper remove
synthetic data after process exit.

The Bun native entry point invokes this probe through proof-run.sh before outbox. Its
failure must retain its status/evidence and withhold the runner's success marker. The
runner fixture covers its failure and fresh-data cleanup. This covers receipt
assertions from the legacy inline writer block, not its separate lock-holder
schedule, outbox, todo or subsequent progress/needs-you contracts. Existing schema,
SQLite and gateway modules are reused without a new transitive ownership or
performance audit.

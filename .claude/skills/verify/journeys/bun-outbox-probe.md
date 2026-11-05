# Build Bun parity for inline outbox exchange receipts

Use the isolation/resource setup in ../SKILL.md with pinned Bun 1.4.2:

    VERIFY_PROOF_RUNTIME=bun bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence scripts/bun-outbox-probe.ts

Commit the unavailable-probe regression before construction. The probe owns a
fresh file-backed DatabaseCore, waits for actual startup body copying and calls
the existing outbox commands through native DbGateway workers with no inline
connection. It starts no listener, model, real bridge or worker. Session IDs,
prompt bytes and the exchange envelope are synthetic; no existing database or
credentials enter the run.

Require a nonempty queued command ID and exactly one mailbox report matching
that synthetic Desktop session's driver origin. Exchange must acknowledge
sequence one, return that same command ID with the complete prompt and sender,
and commit last_sequence one in the journal. These preserve the legacy inline
outbox receipt checks; a returned command is not proof of external execution.

Require startupBodyCopyComplete, promptReport, exchangeReceipt, gatewayClosed,
databaseClosed and pass in bun-outbox.json, plus wrapper exit zero. Existing-data
refusal must leave its retained marker unchanged and create no database. Close
the gateway before the database, inspect retained logs for database-close errors
and let the wrapper remove synthetic data after the process exits. A flag before
a cleanup failure is not success.

The Bun native entry point calls this probe through proof-run.sh before todo
receipts. Its failure must retain its evidence/status and suppress the smoke success
marker; the runner fixture checks its failure and temporary-data cleanup. This does
not cover lock-holder, todo or later progress/needs-you inline contracts. Existing
schema, SQLite and gateway code are reused, without a new transitive ownership or
performance audit.

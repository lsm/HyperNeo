# Build Bun parity for inline todo receipts

Use the isolation/resource setup in ../SKILL.md with pinned Bun 1.4.2:

    VERIFY_PROOF_RUNTIME=bun bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence scripts/bun-todo-receipt-probe.ts

Commit the unavailable-probe regression before construction. The probe owns a
fresh file-backed DatabaseCore, waits for actual startup body copying and uses
native DbGateway workers with no inline connection. Fixtures contain only one
synthetic ask/todo/binding. No listener, model, real worker or live daemon is used.

The full daemon initializes the turn-report cutoff receipt before these reads.
This standalone fixture invokes the existing recordLive writer for a missing
todo (false result) so its repository constructor creates that real receipt on
the writer; require exactly one persisted cutoff before reading. Do not insert
a fabricated marker. The retained pre-bootstrap failure shows the cold reader
cannot initialize this missing receipt on its read-only connection. This is
parity after normal bootstrap, not proof of cold reader initialization or
startup write ownership. Existing-data refusal must leave its marker unchanged
and create no database.

Require the todo in unrecorded starts, absent from awaiting reports, with PR
window start one/end null. Live status must change once, return false on the
same update and be committed as running. Dispatch must return the todo/open ask
and persist its worker ref, model and full sent instruction. A synthetic trigger
must reject a second dispatch with its exact refusal; the complete original
ref/model/instruction receipt must remain unchanged. Do not retry the dispatch.

Reader commands must preserve an asks array and links Map across the native
worker boundary, null/empty results for a missing ask and a checkable array.
Require startupBodyCopyComplete, bootstrapReceipt, recoveryWindow, liveStatus,
dispatchReceipt, dispatchRollback, readerSnapshots, gatewayClosed, databaseClosed
and pass in bun-todo-receipt.json, plus wrapper exit zero. Inspect retained logs
for database-close errors. Close the gateway before the database, then let the
wrapper remove synthetic data after process exit; a flag before cleanup failure
is not success.

The Bun native entry point calls this probe through proof-run.sh before claim lock
coverage. Failure must retain its status/evidence and suppress the runner success
marker. The runner fixture covers its failure and temporary-data cleanup. Existing
schema/SQLite/gateway/repository code is reused without a full transitive
ownership/performance audit.

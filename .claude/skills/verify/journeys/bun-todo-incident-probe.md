# Build Bun parity for todo incident receipts

Use the shared isolation/resource setup in ../SKILL.md with pinned Bun 1.4.2.

    VERIFY_PROOF_RUNTIME=bun bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence scripts/bun-todo-incident-probe.ts

Commit the unavailable-probe regression before construction. The probe owns a
fresh DatabaseCore, waits for actual startup body copying and drives the existing
todo-session commands through native DbGateway workers. Fixtures contain one
synthetic ask, todo and binding.

Progress must commit start/check timestamps, running status, incident reset and
unchecked zero together. A trigger refusing the next check stamp must leave all
five fields equal to their previous values, with the exact refusal observed.
Remove the trigger after the failed command completes.

Two concurrent needs-you claims on the doing todo must admit one winner with
the original todo ID and first supplied incident timestamp. After clearing the
fixture incident, a refusing trigger must preserve the complete prior row.
Closing the todo must return null on a later claim and preserve its row. These
are the progress and incident assertions from the remaining legacy inline block.

Require startupBodyCopyComplete, progressCommit, progressRollback,
singleIncident, incidentRollback, closedIncidentRefused, gatewayClosed,
databaseClosed and pass in bun-todo-incident.json, plus wrapper exit zero. The
existing-data refusal must preserve its marker and create no database. Inspect
retained logs for database-close errors. Close the gateway before the database,
then let the wrapper remove synthetic data after the process exits.

Coverage is the native writer command receipts. Scheduled refresh, notification
delivery, RPC latency and main-thread ownership have separate journeys in
neo-todo-progress-writer.md and neo-todo-needs-you-writer.md. The native entry point
calls this probe last through proof-run.sh. Failure must retain its status/evidence
and suppress the smoke success marker. The runner fixture covers final-case failure
and temporary-data cleanup.

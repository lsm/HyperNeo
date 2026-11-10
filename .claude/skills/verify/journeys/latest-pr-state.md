# Watched pull-request state lookup

Use `proof-run.sh` with pinned Bun and `latest-pr-state.ts`. Run `baseline
<synthetic-db-path>` on the failing reproduction commit, then `upgrade
<same-synthetic-db-path>` and `bootstrap <unused-synthetic-db-path>` on the fix.
The baseline deliberately exits nonzero on the production query plan assertion
and saves its owned synthetic database after daemon shutdown. Never pass a real
database path. The upgrade copies only that synthetic fixture into its disposable
HOME/data directory and boots the actual daemon to run the migration.

The fixture uses the real m331 table and 26,608 synthetic rows, with representative
JSON sizes, neighbouring subjects, mixed case, other sources, poll states, open
synchronize events, unfamiliar actions and timestamp ties. The helper compares
the actual DB gateway read with the legacy SQL and captures the production SQL
and bindings for EXPLAIN. Require source plus expression equality and range
SEARCH operations on the new topic index, unchanged row count and full-row SHA
on upgrade, wrapper exit zero, and resourcesClosed plus passed in the evidence.
Clean bootstrap must independently produce the same results and index plans.

Retain both plans, counts, migration marker, eleven-call median timings and exit
status. Timings describe an isolated warm synthetic fixture, with no CI latency
threshold. The helper owns its ephemeral daemon and closes it in finally.

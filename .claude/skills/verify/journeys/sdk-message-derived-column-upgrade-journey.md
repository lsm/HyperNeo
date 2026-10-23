## SDK message derived-column upgrade journey

Use synthetic bodies only. Before applying the column implementation, run
`NODE_ENV=test bun .claude/skills/verify/sdk-message-columns.ts seed "$RUN"`
then `inspect "$RUN"` with the same helper. The latter must fail because the
derived columns are absent. Seed records 11,000 messages, including full large
tool results and one malformed JSON row, plus a SHA-256 of the valid bodies.
The seed writes `replacement_metadata_normalized=1`, matching production writers
so the unrelated one-time legacy replacement reconciliation does not run.
Use a temporary HOME and `env -i` as in Launch; no real database is read or copied.

With this branch, run `upgrade "$RUN"`, then `inspect "$RUN"`, then `upgrade`
again. End state: all body bytes and the row count match the seed; metadata
matches the body, malformed JSON stays unchanged with NULL derived columns,
and the restart skips completed chunks. Keep the before failure, inspection,
startup lag and chunk logs. Numbered migration 413 adds the columns; the separate
`sdk_message_columns_backfilled_v2` marker records completion of the async pass.
Its cursor commits with each transaction; chunks yield after at most 512 rows
or 4 MiB, with a larger single message kept whole. No body is moved or trimmed.
The standalone upgrade helper explicitly waits for the data pass before inspection;
`schemaReadyMs` separates schema readiness from the full-pass runtime. The daemon
binds before that pass: use `startup-sdk-backfill.md` for serving, readiness and
restart proof. Report any chunk-time budget violation.

Then launch an isolated daemon using [Launch](../SKILL.md#launch) and run
`bash .claude/skills/verify/sdk-message-columns-door.sh <port> "$RUN"`.
This sends through `message.send`, observes the same `messages.bySession`
subscription as the web transcript, and checks stored metadata/body agreement
read-only. Stop and relaunch that isolated daemon, then repeat with a distinct
third argument for the evidence name. Keep both RPC replies and feed snapshots.
GUI rendering is not covered; no real provider, credentials or GUI are used.
Filter characterization cases and assertions remain unchanged and run in CI;
their raw-SQL seed helper fills columns through the production derivation.

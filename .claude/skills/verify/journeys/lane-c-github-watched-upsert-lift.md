# Extract constructor-free watched GitHub UPSERT

Run proof-run.sh with lane-c-github-watched-upsert-lift.ts under Bun. Shared setup owns
scrubbed HOME/data, ephemeral port and cleanup. No model/HTTP mock or credentials; refuse
external HTTP/gh. Never touch the live daemon, port8399, deployment or real HOME. Disable
webhook reconciliation, use a 60-second poll interval and close its timer before it fires.
Finish real body copying and stop captured job processors before measuring.

Real watchRepo RPC creates a disabled-Space row, updates that same identity, then
creates a polling peer. Verify UUID/creation time, resolved Space fallback,
existing UPDATE, saved config and activation cursor marker. Current public calls
use three native config-write posts, create two rows and execute zero main INSERTs.
Compare committed rows with receipts. The polling peer's cursor write may advance
its update clock after creation; its activation marker retains creation time.
Scratch/unit tests retain the exact function and initial SQL contracts below.

Invoke the constructor-free function on scratch watched-table-only SQLite. Activate an
existing row: preserve id/case/creation/last poll/webhook and COALESCE secret, clear only
the existing check-run cursor keys, retain other endpoints. Create an explicit disabled
row with polling true, pin defaults and UUID/time. The source-settings table must stay
absent. Check rejected writes without replay, caller rollback of row plus cursor, and the
existing partial-write boundary when cursor persistence fails outside a caller
transaction. Normalize only SQLite row prototypes across Bun; compare complete field
values.

Unit proofs compare legacy/function receipts and full rows over existing/new,
source/active/flag/null/empty/zero combinations. Pin the legacy disabled-Space
fallback activation behavior without repairing it in this extraction. Trigger
cursor failure with/without caller transaction; preserve current boundaries.
No implicit transaction or automatic replay may be added.

Fresh162 includes both complete 40-line UPSERT and 40-line INSERT modules, UUID15 and
retained repository units. The same five stable modules remain excluded166; total
known328, with no new exclusions. Pin full-file hashes/contracts and test their
interfaces. #9418 tracks lifecycle and coordinated hash/contract bump plus re-audit. Full
public/shared-barrel/runtime transitive closure remains unclaimed. Any extra exclusion
requires a new Neo table/decision; stop/report if review challenges the envelope. Atomic
polling command and public wiring follow as separate remeasured gated slices.

Save github-watched-upsert-lift.json, close scratch/socket/processors/app and
restore hooks in finally. Wrapper retains evidence and removes owned temporary
data. Deployment smoke stays with Neo.

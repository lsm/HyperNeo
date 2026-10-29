# Extract GitHub Space enable persistence

Use proof-run.sh with lane-c-github-space-enabled-extract.ts on Bun and cached
Deno (VERIFY_PROOF_RUNTIME=deno). Shared setup owns fresh HOME/data/ephemeral
listeners, scrubbed credentials, evidence retention and immediate data cleanup.
No provider turn, HTTP mock, GitHub access or live daemon/8399 is used.

Enable the actual GitHub extension RPC capability with polling/webhooks off. Seed
a synthetic Space and add synthetic watched repositories through the real RPC,
with both polling and webhooks disabled. Drive space.github.enable/disable,
listWatchedRepos and listConfig. Preserve enabled flags across source setting,
watched rows and saved Space config, creation times and same-command timestamps.
Four measured main statement runs remain expected; no off-main claim is made.

Commit the failing helper-availability contracts first while legacy RPC behavior
passes. Extract only the source-setting UPSERT and watched-row UPDATE into a
synchronous helper taking caller time and returning the same changed-row count.
Never construct the repository per worker command: its constructor backfills.

Unit tests pin one caller clock, repeat and empty-Space counts, key isolation,
exact statements/binds/result and caller-owned rollback. Preserve legacy partial
failure without an outer transaction; extraction must not silently add atomicity.
Scratch native SQLite also verifies the result count and outer rollback. Pin
SQL/JSON AST and every other repository method, including constructor/backfill.

The full GitHub/plugin/startup/Space closure is not transitively audited. Space
config persistence and future atomic command/wiring remain separate slices.
Save github-space-enabled-extract.json; close scratch DB, socket, processors and
app before wrapper cleanup. Deployment smoke is Neo-owned.

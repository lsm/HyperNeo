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
The activated enable/disable path now expects zero target main writes; this
fixture retains direct helper contracts without a blanket off-main claim.

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
config writer families remain separate; enable/disable atomic writer activation
has its own public RPC proof.
Save github-space-enabled-extract.json; close scratch DB, socket, processors and
app before wrapper cleanup. Deployment smoke is Neo-owned.

The enable/disable RPC now consumes the atomic writer receipt. Archived evidence
retains its original commit-time counts. Current public RPC expectations require
zero target main writes; direct scratch-helper SQL/binding/rollback contracts
remain unchanged, and other public write/read families are not covered here.

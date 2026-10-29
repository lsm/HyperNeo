# Extract watched GitHub repository lookups

Run proof-run.sh with lane-c-github-watched-lookups-extract.ts under Bun and
cached Deno (VERIFY_PROOF_RUNTIME=deno). Shared setup owns scrubbed HOME/data,
free ephemeral ports, evidence and cleanup. No model or HTTP mock is needed.
Never use the live daemon/8399, real credentials or deployment. The fixture
refuses external HTTP/GitHub commands, disables automatic webhook reconciliation
and configures RPC-only GitHub capability with polling/webhooks off.

Stop startup processors and finish SDK body copy before measuring. Create two
synthetic Spaces. Through watchRepo, add a disabled-webhook/non-polling repository,
update it by differently cased owner/repo and add the same key in the other Space.
Check stable identity/case/creation time, changed enabled flag, Space isolation,
public sanitized replies and saved listConfig rows. Observe both legacy key/id
SELECTs on main. Before extraction these RPCs pass, then missing-helper assertions
fail; commit those red proofs first. No public off-main claim is made.

Use a scratch database containing only the watched table in query-only mode.
Both helper lookups must retain the complete mapped row, case matching, missing
null results and malformed matching-cursor errors. No settings table is created.
Focused contracts also read caller-uncommitted rows and retain caller rollback.
Measurement pins exact SELECT/binding/map/null ASTs, other repository units/types,
constructor/backfill and public roots. Count complete helper and mapper modules
plus conservative wrappers/constructor. Full transitive public/UPSERT/cursor,
plugin and startup closure is outside this extraction; later writer construction
and public wiring require their own measurements and proofs.

Save github-watched-lookups-extract.json. Close scratch DB, socket, all captured
processors and owned app in finally, restore hooks, then let the wrapper remove
all temporary daemon data. Deployment smoke stays with Neo.

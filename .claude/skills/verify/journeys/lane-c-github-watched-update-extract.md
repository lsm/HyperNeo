# Extract existing GitHub watched-repository UPDATE

Run proof-run.sh with lane-c-github-watched-update-extract.ts under Bun and
cached Deno (VERIFY_PROOF_RUNTIME=deno). Shared setup owns scrubbed HOME/data,
free ephemeral port, evidence and cleanup. No model/HTTP mock or credentials.
Never touch live daemon/8399, deployment or the real HOME. Refuse external HTTP
and gh, disable webhook reconciliation, and inject a 60-second poll interval
through existing options; cleanup stops the owned timer before it fires.

Finish startup body copying and stop processors. Seed existing non-polling
watched rows in two synthetic Spaces. Through watchRepo update the primary row
off, activate it again with polling, then update the peer. Owner/repo casing
must retain id/canonical case/creation time; compare each actual UPDATE's bound
clock to its committed row, unchanged last-poll time, public reply and saved
listConfig. Peer row stays untouched by primary calls. Existing activation still
adds the check-run cursor marker and retains unrelated cursor/ETag data. Expect
three main UPDATEs before/after: this extraction makes no public off-main claim.
Commit red helper failures first while the real RPC characterization passes.

Scratch SQLite has only the watched table. The helper retains supplied time,
void result, flags, all unrelated fields, failure state and caller rollback.
Focused unit contracts compare exact legacy/helper SQL and bindings across
flag/default/COALESCE/null/empty/zero cases before unchanged cursor policy runs.
Pin single-attempt failure, peer/id isolation, no initialization and no clock
read. The four excluded stable modules have full-file hash and interface tests:
key/id lookup, complete row mapper/list, absent/present settings getters, and
cursor serialization/clock/rollback. Matching malformed cursors still reject.

Measure in the unmerged slice branch; after merge use the saved evidence/base.
Neo approved fresh envelope 199 (including the complete UUID fallback leaf),
plus 102 excluded stable lines, 301 total known. The four constructor-free
modules are pinned by full-file hashes/contracts and interface tests. Full
public/shared-barrel/runtime transitive closure is not claimed. If review
challenges the envelope, stop and report to Neo. INSERT, reduced UPSERT lift,
command construction and public wiring remain separate gated slices, remeasured
after each merge. No core/shared edits beyond the one smoke registration here.

Save github-watched-update-extract.json. Close scratch DB, socket, processors,
owned app/timer and restore hooks in finally, then remove owned temporary data
through the wrapper. Deployment smoke stays with Neo.

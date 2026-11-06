# Extract polling capability queries

Use shared setup in `../SKILL.md`. Run `proof-run.sh` with
`lane-c-github-polling-read-extract.ts` under Bun. The helper first runs the actual
polling writer RPC journey, including enable/disable, saved config, held writer health,
rollback and no replay. It retains that journey's evidence and closes its owned daemon
before checking the extracted reader contracts.

On query-only native SQLite with no repository construction, preserve complete
rows, owner/repo ordering, empty/all/Space filters, orphan and session selection,
disabled configured rows and joined intent counts. Focused tests also preserve
malformed-cursor and missing-schema errors and reject clock reads or schema writes.
Commit the missing-helper regression before extracting the exact SQL bodies.

Count the complete new helper, the complete existing mapper module, legacy
wrappers and unchanged constructor/mapper wrapper within this slice. No newly
excluded dependency is needed. Refresh the existing polling wiring interface
pins and contracts for the three deliberately shortened delegation methods;
that test still pins the same twelve interface roots and claims no transitive
audit. SQL byte/AST equivalence is checked against the recorded pre-extraction
methods; no capability, timer or selection policy changes in this rung.

Retain `github-polling-read-extract.json` and imported RPC evidence. The original slice proved extraction. Later watch validation, mutation and
polling-command slices own their separate native gateway proofs. Other callbacks
and startup still require the final guard scope decision. Real GitHub, GUI, live deployment and full public closure are
unverified. The shared wrapper owns cleanup; never use port 8399 or live data.


## Retired webhook wrapper deletion

Run lane-c-github-polling-read-measure.cjs. Its committed red assertion rejects
both retired clear wrappers before deletion. After removing them, all remaining
repository method and constructor hashes must match the prior contract. The
constructor-free clear helpers remain available to the watched-config writer.
The health regression calls that retained helper directly and still requires a
cleared delivery timestamp.

Run the GitHub suite and github-watch-polling-writer.ts through proof-run.sh with
fresh synthetic data. Require zero target main SQL, real writer posts, rollback,
retained known commits after later failures, no lost-receipt replay and clean
teardown. The deletion removes twelve production lines and adds no new runtime
path. The earlier polling-writer measurement keeps its control-root budget unchanged.
Its old PR-specific historical diff check is removed because subsequent fresh-dev
slices include unrelated merged changes. Measure this deletion diff separately
against its fresh dev base; remaining method hashes stay enforced. Retain fixed evidence and the repository check output outside the worktree.

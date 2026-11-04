# Extract polling capability queries

Use shared setup in `../SKILL.md`. Run `proof-run.sh` with
`lane-c-github-polling-read-extract.ts` under Bun and Deno. The helper first runs
the actual polling writer RPC journey, including enable/disable, saved config,
held writer health, rollback and no replay. It retains that journey's evidence
and closes its owned daemon before checking the extracted reader contracts.

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

Retain `github-polling-read-extract.json` and imported RPC evidence. This is an
extraction proof, not worker activation: callback reads still run on main and
block #9438/#8714. Real GitHub, GUI, live deployment and full public closure are
unverified. The shared wrapper owns cleanup; never use port 8399 or live data.

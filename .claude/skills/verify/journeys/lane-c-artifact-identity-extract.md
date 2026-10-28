# Extract artifact file identity SQL

Use proof-run.sh with lane-c-artifact-identity-extract.ts on Bun and native cached
Deno (VERIFY_PROOF_RUNTIME=deno). Shared setup checks resources, scrubs credentials,
creates fresh HOME/data and ephemeral listeners, saves evidence and removes data.
No provider/model, native agent, real credential, GitHub or live daemon is used.
These are historical extraction contracts: direct default constructor/helper
execution stays on its supplied connection. Current reference RPC identity is
worker-backed; use the reference-identity journey to prove that activation.
The original extraction measurement/evidence is historical; use the current
identity/reference measurement for the evolved layout.

Commit the failing helper-availability contract first. The existing real
artifact.reference.resolve RPC must still refuse a missing synthetic source,
initialize one UUID row and retain that row on a repeated request. After extraction,
the public refusal/identity behavior stays the same and the helper becomes available.
The first setup used an incorrect operation name; retain its logs and never count
that setup failure as a reproduction.

Compare exact INSERT/read SQL order and UUID binding shape on fresh/retained
scratch identities. Unit tests additionally pin the literal generated UUID argument.
Both entrypoints must preserve the first singleton, caller-owned rollback for new
and existing rows, insertion errors and read errors. A read error outside an outer
transaction leaves the preceding insert intact; inside a caller transaction it
rolls back. Preserve that existing distinction rather than adding atomicity here.
Run the actual artifact RPC again after the helper checks and observe unchanged
identity/refusal plus responsive health. Retain the expected main statement trace: current reference RPCs execute no
identity SQL on main; the explicitly invoked direct legacy helper executes its
INSERT/read there. Positive direct-helper counts characterize that legacy path
and must not be claimed as a complete off-main pass. Save SQL hashes, timing and RSS/WAL without UUIDs or private paths.

Run the focused SQL/constructor contracts, strict checker, source/diff measurement
and repository checks. Net prepare/run counts must be zero and receipt/save method
bodies byte-identical. Append only this journey's Deno smoke line. Close scratch
DBs, socket, processors and app before data cleanup. Full capture/FS/ownership/source
graph, successful snapshot publication, native Bun 1.4.2 when another Bun is installed,
browser and Neo-owned deployment smoke remain unverified by this helper extraction.

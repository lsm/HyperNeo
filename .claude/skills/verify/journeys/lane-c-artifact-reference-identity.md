# Reference planning identity activation

Use proof-run.sh with lane-c-artifact-reference-identity.ts on Bun and cached Deno
(VERIFY_PROOF_RUNTIME=deno). Shared setup owns fresh HOME/data and ephemeral listeners,
scrubs credentials and checks resources, saves evidence and removes temporary data.
No provider turn, external GitHub, real native state or live daemon is used.

Commit the failing real artifact.reference.resolve RPC proof first. Deny cached/new
identity INSERT/receipt SELECT on main. Discovery/non-human calls and missing retry
IDs must dispatch zero identity commands. Inject admission rejection and loss of a
committed identity reply: no fallback/capture/replay; later explicit calls retain
the identity. Hold a competing writer lock, keep health responsive, then remove the
stored source immediately before delivering the committed receipt on main. Planning
must load current source after its await and refuse without capturing a row.

On Bun restore the source, concurrently resolve one tap, retain one receipt and read
original snapshot bytes publicly. Remove stored source after capture but before the
resolver receives its revalidation identity receipt: withhold the reply while
retaining committed bytes/row; a later explicit retry recovers the same receipt.
Preserve absent/missing/sensitive source refusals. Deno keeps its existing native
safe_open_unavailable refusal; successful Deno capture/bytes are unverified.

Only resolver identity initialization moves in this slice. Row publication, source
reads, Git capture identity and public read-only authorization remain main-side.
Count the separate read-only verification identity SELECTs explicitly. Pin the merged
identity command and registration dependency by exact hashes/contracts. Count the
whole local resolver module including closures/schema/constants to <=200 lines;
pin unchanged source/planner/capture/descriptor/PR/Git module boundaries with direct
imports, but do not claim their full transitive repositories/runtime/OS/library
implementations are measured. Callbacks remain main-side and never cross a writer
transaction; only UUID data is sent. Run focused/strict tests, native proofs and
root checks. Update the prior extraction helper's historical main-trace expectation
now that real reference RPC identity is worker-backed. Append only the owned smoke
line. Browser, native pinned Bun when unavailable and Neo-owned deployment remain
unverified. Always close owned sockets/processors/app before data cleanup.

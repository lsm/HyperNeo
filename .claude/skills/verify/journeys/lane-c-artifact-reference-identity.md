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

Restore the source and concurrently resolve one local tap. On both runtimes,
require client_upgrade_required with upgrade guidance and zero snapshot rows or
blobs; explicit retries retain the identity but cannot capture. Preserve
absent/missing/sensitive source refusals. Registered-ID reads and immutable Git
captures are exercised by their separate retained journeys.

This journey originally moved only resolver identity initialization. Current
registration/Git identity and row publication are covered by their later journeys;
source/receipt reads and public read-only authorization remain main-side.
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

C2 update: valid local worktree taps now refuse with client_upgrade_required on
Bun and Deno before descriptor capture. The identity proof retains its admission,
lost-reply, writer-contention, source and sensitive-path fences, but requires zero
snapshot rows/blobs even for concurrent retries. It makes no successful-capture
claim. Retained registered-ID bytes and Git versions have their separate proofs.

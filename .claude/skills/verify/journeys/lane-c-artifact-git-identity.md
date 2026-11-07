# Git capture identity activation

Use proof-run.sh with lane-c-artifact-git-identity.ts on native Bun. Shared setup checks
resources, owns fresh HOME/data and ephemeral listeners, scrubs credentials, saves
evidence and removes temporary data. The owned gh stub is Python and answers only exact
synthetic commit/tree/blob API keys; every other call refuses. Never access real GitHub,
credentials or port 8399.

Commit the failing real artifact.reference.resolve Git RPC proof first. Self-check
cached/new identity SQL traps, then deny target SQL on main. The first command is
already-routed reference planning; inject rejection/lost committed reply into the
SECOND identity command (Git capture). Assert no lookup/capture/fallback/automatic
replay and retained identity. Only later explicit requests may recover.

Reserve the JS per-database capture lane synchronously before its first await. Unit
tests hold identity admission, dispatch two explicit captures and require the first
identity/current callback to finish before the second initializes. Initialization
failure releases the lane for another explicit call without replaying callbacks.
Keep repository/resource data main-side in the existing pipeline; identity admission sends only UUID data; separately activated row publication sends
only save arguments to its own worker transaction. No FS/network/current callback crosses it.

In the native RPC proof acquire the competing writer lock at the Git identity command post
boundary, after reference source planning completes. Health remains responsive; the
affected RPC is intentionally slow. Remove stored source just before delivering the Git
receipt; current-source revalidation must refuse before the first fixture lookup. Restore
source and concurrently resolve one tap. Bun returns one immutable row/receipt, verified
commit/blob provenance and all 1.56+ MB in <=256 KiB chunks. Remove all Git fixtures and
explicitly retry: return the committed receipt without a new lookup. Assert both
fail-closed outcomes explicitly, zero immutable rows and retained identity. No fallback or
backend change is added. Foreign/non-source references refuse before lookup.

It reports current executable units, hashes, imports and the branch diff, not an
unchanged-boundary claim against historical registration snapshots. Local registration and
its old measurement scripts were removed by C3. The wrappers for historical
identity/reference measurement names now report this same current inventory. Immutable
Git, row/identity command and legacy reader proofs remain the behavioral gates; a source
inventory cannot replace them.

The first fixed proof held the lock too early, immediately after the reference
identity receipt. Source binding construction then reached the existing core
NeoTurnReportReceipts -> JobQueueRepository.commitSubmissionReceipt immediate
transaction on main and stalled before Git admission. Retain failed/diagnostic
logs and report this remaining transitive writer for #8714; do not claim that
holding a lock before all source planning leaves the main thread responsive.
Do not change core receipt code here. The final lock proof isolates this slice
at Git identity admission, with source callbacks after its committed receipt.

Seed the source todo repository in `pack_coding_todos` and assert its legacy
`neo_todos.repo` stays null. A frozen legacy value cannot authorize Git capture
after canonical storage activation.

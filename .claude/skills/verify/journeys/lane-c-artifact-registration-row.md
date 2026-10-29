# Artifact registration row publication activation

Run proof-run.sh with lane-c-artifact-registration-row.ts on Bun and cached native
Deno (VERIFY_PROOF_RUNTIME=deno). Shared setup checks resources, owns fresh HOME,
synthetic data and ephemeral listeners, saves evidence and immediately removes data.
No provider/model, native account, external GitHub or live daemon/8399 is used.

Commit the failing public registration RPC proof first: cached/new main INSERT guard
self-checks must work, then publication must execute zero main artifact row INSERTs.
On Bun, concurrent identical requests share the capture lane and one worker command;
retries return the retained receipt. Read original and revised snapshots through
the real artifact.file.read RPC. Changed source retains both immutable revisions.

Reject row admission before commit: propagate error, no row/fallback/replay, allow
a later explicit request. Drop a real committed reply: RPC rejects unknown outcome,
no automatic replay, and a later explicit retry reads the exact retained receipt
without another mutation. Before delivering a committed reply, remove only this
synthetic ask binding: registration must refuse the reference despite its retained
row, remain refused while access is absent, then read that same receipt after
the synthetic binding is restored. No reset/replay of the write is allowed.

Acquire the competing WAL writer inside the row-command post hook, after main-side
source planning and pre-admission checks. Hold for 1.2 seconds: health must respond,
both same-request RPCs wait, and after release they return one identical receipt.
This excludes earlier source-binding construction (#9342); no whole-RPC SQL or
whole-daemon latency claim is made. Policy, capture and callbacks stay main-side;
only the existing save arguments cross the command boundary.

Deno retains the documented safe_open_unavailable capture refusal, no row/command
and no path fallback. Successful Deno row activation, bytes and contention fences
remain unverified here; the merged construction journey tests its native writer.
Sensitive/traversal refusals remain unchanged on both runtimes.

Measure every local registration executable root (including closures/storedKind)
to <=200 lines; separately pin the complete merged 135-line row writer and 31-line
identity command subtree plus full unchanged policy/capture/import roots. Be explicit
that their transitive repository/runtime/OS graphs are not fully audited. Existing
receipt/authorization reads and sync descriptor work remain main-side, and Git
publication is separate. Update earlier owned journeys whose row-INSERT expectation
changes, rerun them, strict types/focused tests and repository checks. Use only one
append-only smoke line; no shared/core edits. Native pinned Bun when unavailable,
browser and Neo deployment remain unverified. Close owned resources before cleanup.

Native integration children retain artifact-proof-phases.json (imports, daemon
startup, processor stop, SDK body copy, each RPC fence and cleanup). The test parent
includes that trace and child stdout/stderr in failures before deleting its run.
The existing 30-second deadline and proof assertions remain unchanged. Startup
body-copy EACCES is covered by sdk-backup-directory-umask.ts and its journey:
the real worker must finish its verified backup while the socket bind holds its
0177 mask, with the backup directory still 0700. The same test file runs that
regression before the public artifact RPC proof. A passing macOS RPC run alone
does not explain other Linux timeouts; identify their actual phase before
changing budgets or production behavior.

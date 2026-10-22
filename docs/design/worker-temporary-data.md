# Worker temporary data has an owner

Docs-only proposal; no cleanup runs in this PR. Reported on 2026-10-22:
2.6G free, `/private/tmp` 288G (about 140G added in a day), Go cache 56G, Zig
cache 19G, stale worktrees about 45G. Implement these three parts after approval.
Daemon source references below are relative to `packages/daemon/src/`.

## 1. Core: session-owned temporary directories

**Reuse:** the generic `work.start` adapter boundary (`lib/drivers/work-operations.ts:297`),
worker lifecycle facts, and the persisted job queue/processor (`app.ts:1264,1472`).
**New:** before starting a worker, create a private directory under
`<dataDir>/tmp/workers/<owner-id>/`; persist its association with the worker ref.
Pass that directory as `TMPDIR` through the adapter's actual execution environment,
including resumed turns. Do not change a shared desktop application's global environment;
per-thread environment propagation must be proved for each adapter, not assumed.
On confirmed session end, stop/wait for owned children, then remove its directory.
A stopped turn is not a session end. An hourly queued sweep removes abandoned
owned directories older than 24 hours; never remove one still owned by a live session.
Check containment and do not follow symlinks. Core knows nothing about PRs or compilers.
**Verify:** isolated `NODE_ENV=test` daemon and synthetic workers: distinct inherited
TMPDIRs, child writes contained, end cleanup, restart/orphan sweep at a fake 24-hour
clock, and live owners/outside sentinels preserved. Preserve selected proof through
the existing artifact path before ending the worker. No live-data cleanup test.

## 2. Coding pack: worktrees and build caches

**Reuse:** coding preparation (`lib/neo/packs/coding/prepare-execution.ts`), ledger
MERGED/CLOSED facts (`pr-ledger.ts:130`), pack sweep (`pack.ts:95`), Git worktree
removal and the same job queue. **New:** retain the owned execution path/PR association;
on merge or close, remove that PR's unused, clean worktree. Reconcile terminal ledger
facts again after restart so a missed event cannot leak it. Keep dirty/shared/live
worktrees and report the reason; never remove main/neo-read checkouts or branch history.
Queue a daily build-cache trim in the pack: Go's own `go clean -cache`, and Zig's
identified generated cache directories, only while their workers/builds are idle.
No generic home-directory cleanup, compiler/runtime installation removal or model deletion.
**Verify:** synthetic Git repo/ledger and disposable cache roots: merge and close
release only their owned worktrees; open/dirty/shared/live cases survive; restart is
idempotent. Stub cache tools assert the exact disposable targets; verify real cleaners
only with isolated Go/Zig cache overrides. Core must not import the coding pack.

## 3. Repositories: obey the inherited TMPDIR

**Reuse:** existing verify/test helpers and `mktemp`/language temp APIs. **New:** replace
absolute temp outputs with unique children of `$TMPDIR` (or `os.tmpdir()` /
`tempfile`); pass it through `env -i`. Do not rewrite fixture text, already-honored
fallbacks, or simulator-container paths. Read-only inventory below is from
`~/.hyperneo/worktrees/lsm/<repo>/neo-read` on 2026-10-22; braces enumerate filenames.

| Repo / audited head | Real hard-coded temp writes / writer roots |
| --- | --- |
| HyperNeo `1981b070c4` | `.claude/skills/verify/preview-bundle-proof.sh:17` forces `TMPDIR=/private/tmp`; `packages/daemon/tests/helpers/daemon-server.ts:402,409` creates workspace/worktree roots. `packages/daemon/scripts/benchmark/graph-tools/{run-baseline,run-codegraph,run-ast-grep,run-crg,run-graphify,benchmark-helpers}.ts` uses absolute result/build paths. `scripts/{seed-ui-demo,seed-agent-pool-demo}.ts` creates absolute demo workspaces; `.github/workflows/main.yml:624` fixes the daemon-smoke data root. |
| HyperNeo test allocations | Under `packages/daemon/tests/`: `unit/1-core/core/backfill-deepseek-provider.test.ts`; `unit/1-core/drivers/claude-{desktop-mods-{runtime,control,server,driver},inbox,inbox-setup}.test.ts`; `unit/4-space-storage/{skills-manager,storage/{claude-desktop-{bridge,outbox}-repository,sqlite-busy-retry}}.test.ts` allocate real absolute directories/SQLite files. |
| neo-ios `6ea9c94846` | None in executable verify/test helpers: matches are TMPDIR fallbacks, path assertions, or simulator-container-relative paths, not host temp writes. |
| open-agent-protocol `142367dd7e` | `.claude/skills/verify/scripts/check.sh:4` (`mktemp /tmp/...`), `.claude/skills/verify/scripts/acp-permission-publication.py:117` (`TemporaryDirectory(dir="/tmp")`); `.github/workflows/{ci,ci-zig}.yml` hard-code Zig install/smoke outputs. |
| qlark `e26a72d63c` | `scripts/bench.sh:7` fixes Xcode derived data at `/tmp/qlark-dd`. |

**Verify:** run each changed helper with synthetic inputs and a unique TMPDIR;
observe all created test/build outputs beneath it, retained evidence outside it,
and no writes to global `/tmp`. Grep is an inventory, not runtime proof; allocation
and cleanup remain unimplemented/unverified in this docs-only PR. No existing temp
data, caches, worktrees or stored sessions are cleaned up by this task.

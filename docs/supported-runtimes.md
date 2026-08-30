# Supported runtimes

HyperNeo's daemon runs under two runtimes: **Bun** (the pinned release runtime) and **Deno** (a supported alternative). This is deliberate dual support, not a migration — every dev/prod default stays on Bun, and CI watches Deno compatibility with a boot-smoke job on every trigger (non-blocking for now, see [CI coverage](#ci-coverage)) so drift surfaces early rather than at a runtime switch.

## Runtime matrix

| Runtime | Pinned version | Status | CI guard |
| --- | --- | --- | --- |
| Bun | 1.4.0 (`packageManager` in root `package.json`) | **Release runtime.** All dev/prod entry points, tests, and compiled binaries. | Full CI: check job, daemon unit/online shards, web shard, release build |
| Deno | 2.9.4 (`.github/workflows/main.yml`, `deno-boot-smoke` job) | **Supported alternative** for booting and running the daemon. No unstable flags required. | `deno-boot-smoke` job on every trigger + manual Deno session-loop integration test |
| Node | — | Not supported. No claim is made about running the daemon on plain Node. | — |

The supported Deno line is **2.9.x**. The integration test skips itself unless `deno --version` reports 2.9, so an accidental local Deno downgrade surfaces as a skipped test rather than a confusing failure.

## Running the daemon under Deno

Deno resolves workspace npm dependencies from the bun-installed `node_modules` (BYONM), so install once from the repo root:

```bash
bun install
cd packages/daemon
DB_PATH=/tmp/hyperneo-deno-$(basename $(git rev-parse --show-toplevel)).db deno run -A main.ts
```

- No unstable flags are needed: the PR3 codemod made every extensionless relative import an explicit `.ts` import, the `@hyperneo/shared` exports map is Deno-strict, and Deno remaps the remaining `.js`-suffixed relative imports inside `src/**` to their `.ts` files via the discovered `packages/daemon/tsconfig.json` (files outside its `include` — e.g. `tests/**` — do not get that remapping and must use explicit `.ts` specifiers).
- The same DB isolation rule as Bun applies — the daemon DB has a PID lock, so always pass a `DB_PATH` unique to the checkout. The basename idiom above matches the repo's established Bun convention and covers this repo's worktree naming; if your checkouts share a final directory name, include more of the path. A second daemon pointed at a live DB is rejected by the lock rather than silently sharing it.
- The port comes from `HYPERNEO_PORT` (default 9283).
- There is no `/api/health` route; probe `GET /` (expect 200) or the `/ws` WebSocket handshake.
- Convenience task, alongside the Bun one: `bun run dev:deno` in `packages/daemon` (runs `deno run -A --watch main.ts`). Stop it with Ctrl+C — a single SIGTERM shuts the daemon down gracefully but can leave the Deno watch supervisor process lingering, so scripted/probe use should prefer the plain `deno run -A main.ts` form (which is what `scripts/deno-smoke.sh` runs).

## Version pin policy

Both runtimes are pinned to **exact versions** — no `^`/`~` ranges, matching the repository-wide exact-pin policy for npm dependencies:

- **Bun**: root `package.json` `packageManager: "bun@1.4.0"` plus `bun-version: 1.4.0` in every CI setup step.
- **Deno**: `deno-version: 2.9.4` in the `deno-boot-smoke` CI job (`denoland/setup-deno@v2`). There is no `deno.json`; the workflow is the pin of record.

Bumps are deliberate, coordinated edits landing through a PR like any other change: for Bun, the root `packageManager` pin plus every CI `bun-version` step together; for Deno, the workflow pin plus the `isDeno2Point9()` checks that gate the session-loop test and its `deno-daemon-server` helper — those checks are the real enforcement of the supported line (a stale check leaves the manual integration suite skipped or rejected), so a minor-version bump touches them too.

## CI coverage

Dual support is guarded in two places:

1. **`deno-boot-smoke` job** (`.github/workflows/main.yml`) — boots the daemon under the pinned Deno via `scripts/deno-smoke.sh` and asserts the boot contract: HTTP 200 on `/`, the `/ws` WebSocket handshake, > 80 sqlite tables created by migrations, and graceful SIGTERM shutdown. It runs on every trigger regardless of the daemon/web path filters (docs-only PRs included); the one exception is manual `run_e2e_only=true` workflow dispatches, which skip it via the job-level `if`. It is `continue-on-error` (non-blocking) until it has been green long enough to flip required.
2. **Deno session-loop integration test** (`packages/daemon/tests/online/deno/session-loop.test.ts`) — a full mocked session loop against a Deno-booted daemon: session create with worktree, message send, assistant reply delivery. It is exempt from the online shard matrix (manual-only, needs Deno 2.9.x on PATH):

```bash
cd packages/daemon && bun test ./tests/online/deno/session-loop.test.ts
```

- Known gap: the native folder-picker dialog (`dialog.pickFolder`) still spawns through `Bun.spawn` directly (`packages/daemon/src/lib/rpc-handlers/dialog-handlers.ts`), so under Deno the handler catches the resulting error and returns `null` — folder picking in the workspace/Space creation UIs silently no-ops. The `runtime-spawn` seam covers the space runtime and SDK subprocesses; porting the dialog handlers onto it is future work.

## Why dual support is cheap: the runtime seams

The daemon avoids runtime-specific APIs at the seams, so each runtime plugs in a backend:

| Seam | Bun backend | Deno/other backend |
| --- | --- | --- |
| `packages/daemon/src/storage/sqlite-compat.ts` | `bun:sqlite` | `node:sqlite` (Deno ships it since 2.2) |
| `packages/daemon/src/lib/runtime-server/` | `Bun.serve` | `node:http` + `ws` (provider bridges, CLI server) |
| `packages/daemon/src/lib/runtime-spawn/` | `Bun.spawn` | `node:child_process` (space runtime, SDK subprocesses) |
| `packages/daemon/src/lib/runtime-hash.ts` | pure-TS wyhash (both runtimes) | same — stable cross-runtime worktree identity |

`SQLITE_BUSY` detection and the `sleepSync` fallback work identically under both runtimes (Bun surfaces the `SQLITE_BUSY` code; Deno surfaces the `database is locked` message — both are matched).

## Not in scope

- No `deno.json` or import-map migration — module resolution stays package.json `exports` + bun-installed `node_modules`.
- No `deno compile` pipeline — release binaries remain Bun-compiled.
- Dev and prod defaults stay on Bun (`make dev`, `make run`, `make compile`).

## `deno compile` smoke (non-release)

A `deno compile` of `packages/daemon/main.ts` is runnable for smoke checks; the resulting binary is not part of the release pipeline (Bun stays the pinned release runtime, see above). It needs three things the regular `deno run` boot does not:

1. **Static imports only** — the computed dynamic import at `packages/daemon/src/lib/providers/factory.ts:298` (`import(`./anthropic-copilot/index.js?retry=${n}`)`) is replaced by a static specifier; the retry semantics are kept at the factory level (`copilotProviderModule = null` between attempts plus the existing `COPILOT_IMPORT_RETRY_BACKOFF_MS` window). Without the static specifier the bundler bails on `factory.ts` and the binary dies at runtime with `Module not found: .../providers/factory.js`.
2. **`@types/node` available for typecheck** — `deno compile` resolves `node:` built-ins through `@types/node`. The dev-time choice was an `npm:@types/node` devDep in `packages/daemon/package.json` (Deno discovers it via the bun-installed `node_modules` BYONM; Bun's `tsconfig.json` `types: ["bun"]` keeps it out of Bun typechecks). `packages/daemon/deno.json` exists solely to layer a `compilerOptions` slice on top of the daemon `tsconfig.json` (DOM lib for `console`/`crypto` globals, `types: ["bun", "node"]`, the `@hyperneo/*` paths) — it does **not** change module resolution and the existing `package.json` exports remain authoritative.
3. **`--bundle` + pruned embed** — without `--bundle`, the binary references per-file temp-dir paths that the runtime cannot resolve; with `--bundle`, every reachable module collapses into one `.deno_compile_bundle_*.mjs` and the binary boots cleanly. Size reduction then comes from excluding `node_modules` (`--exclude=node_modules --exclude=.deno`), which drops the binary from 1.7 GB to ~292 MB on the current macOS-x64 spike (vs. the 83 MB Bun reference; the gap is the Deno runtime + the unavoidably embedded daemon/web bundles).

Recommended command:

```bash
cd packages/daemon
deno install --entrypoint main.ts                 # populate node_modules/.deno for resolution
deno compile --bundle --no-check -A \
  --exclude=node_modules --exclude=.deno \
  --output=dist/bin/hyperneo-deno-darwin-x64 main.ts
```

Acceptance for a smoke binary: HTTP 200 on `/`, `/ws` handshake, migrations, graceful SIGTERM (`scripts/deno-smoke.sh` adapted to the binary path). The `--no-check` flag is forced by pre-existing typecheck errors that are out of the slice's merge contract (which limits changes to the factory.ts restructure + build tooling/config).

## Future work

- `deno check` type coverage in CI (the `bun-types` vs Deno types gap is real and untested).
- Port the remaining direct `Bun.spawn` call sites — the dialog folder picker above — onto `runtime-spawn`.
- Flip `deno-boot-smoke` from `continue-on-error` to a required check once it has been green for a sustained stretch.
- Resolving the remaining `deno compile` typecheck errors so `--no-check` can be dropped (currently blocked by pre-existing `override` / `URL` / `BlobPart` issues in the daemon and shared packages).
- Closing the Deno-binary vs. Bun-binary size gap (the Deno runtime alone is ~80 MB, leaving little headroom under a 2x-of-Bun budget once the daemon + web bundles are embedded).

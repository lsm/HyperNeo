# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

HyperNeo is a browser UI for the Claude Agent SDK: multi-session chat, provider/model switching, file/git operations, MCP servers, checkpoints, and Space multi-agent workflows.

- **Runtimes:** Bun 1.4.2 (pinned release runtime, root `package.json`) and Deno 2.9.x (supported alternative for the daemon; see `docs/supported-runtimes.md`). Plain Node is not supported.
- **Backend:** Hono, Claude Agent SDK, SQLite
- **Frontend:** Preact + Signals + Vite + Tailwind; use Preact conventions, not React-specific APIs
- **Transport:** custom MessageHub RPC/pub-sub protocol over WebSocket
- **Tests:** Vitest for daemon, shared, web, ui, and cli; Bun test for messaging; Playwright for E2E. Daemon and shared tests import from `bun:test` but CI runs them under Vitest through `packages/daemon/tests/bun-test-shim.ts`.
- **Dependencies:** exact version pins only — CI rejects `^`/`~` in any `package.json`.

## Monorepo

- `packages/cli` — `hyperneo` entry point and HTTP wrapper
- `packages/daemon` — backend, sessions, providers, persistence, operations, Space orchestration
- `packages/shared` — shared types, MessageHub protocol, `OPERATION_NAMES`
- `packages/messaging` — transport-independent messaging contracts
- `packages/prompts` — agent-facing prompts authored as markdown; `src/mod.ts` imports every `.md` at runtime via `with { type: 'text' }` (supported by both Bun and Deno) — there is no generated registry and no sync step; the attribute is mandatory (Bun silently renders attribute-less `.md` imports to HTML)
- `packages/web` — Preact frontend
- `packages/ui` — component library
- `packages/skills` — bundled skill plugins (`SKILL.md` directories, copied to `~/.hyperneo/skills/` at startup and registered as local SDK plugins)
- `packages/desktop` — Tauri shell
- `packages/e2e` — Playwright tests

Workspace aliases resolve directly to source: `@hyperneo/shared`, `@hyperneo/daemon`, `@hyperneo/ui`, and package-local `@/*`.

## Commands

```bash
# Development — always isolate the DB in a worktree
make dev PORT=8484 DB_PATH=/tmp/hyperneo-$(basename $PWD).db

# Daemon under Deno (dual support) — same DB isolation rule; needs `bun install` first
cd packages/daemon && DB_PATH=/tmp/hyperneo-deno-$(basename $(git rev-parse --show-toplevel)).db bun run dev:deno

# Quality
bun run check        # no-comments, format, lint, types, knip, then the repo guards listed below
bun run typecheck
bun run lint:fix
bun run format       # `make format` also strips comments first
make setup-hooks     # pre-commit hook: lint, format check, typecheck, knip

# Tests — never run `bun test` from repository root
./scripts/test-daemon.sh                  # all daemon + shared unit shards (Vitest)
./scripts/test-daemon.sh 5-space-a        # one shard (shared, 1-core, handlers-migrations, storage-migrations, 5-space-a/b)
./scripts/test-daemon.sh --rerun          # only previously failing files
./scripts/test-daemon.sh --show-failures  # failure details from the last run
cd packages/daemon && bun test tests/unit/some-test.test.ts   # bare-bun single file; add --preload=./tests/unit/setup.ts if ambient env leaks in
cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/convo/multiturn-conversation.test.ts
cd packages/web && bunx vitest run src/lib/__tests__/some.test.ts
cd packages/ui && bunx vitest run
make run-e2e TEST=tests/features/foo.e2e.ts

# Build
make build
make compile
```

Prefer unit/component tests; add E2E coverage only when explicitly requested or the behavior genuinely requires browser-level validation.

## Quality guards

`bun run check` runs in CI as `make check`. Beyond lint/format/types, it enforces these repo-specific invariants:

- `check:no-comments` — zero comments in `.ts`/`.tsx` (see Style below). Runs first so nothing can mask it.
- `check:session-guards` — only allow-listed UI RPC paths may call session delete/archive primitives (`deleteSessionResources`, `archiveSessionResources`, raw `deleteSession`). Extend the allowlist in `scripts/check-session-deletion-callers.sh` deliberately; anything else is the data-loss path that was closed.
- `check:operation-names` — every `defineOperation({ name })` in the daemon must be declared in `OPERATION_NAMES` (`packages/shared/src/types/operation-names.ts`), and no declared name may lack a definition.
- `check:db-schema-parity` — the unit-test schema helper `createSpaceTables` (`packages/daemon/tests/unit/helpers/space-test-db.ts`) must match the migrated production schema column-for-column for the tables it covers. Adding a column or table in a migration means updating the helper in the same PR.
- `check:test-matrix` / `check:online-shards` — every test file must be reachable by exactly one CI shard. Shards are directory globs plus hash-split buckets defined in `scripts/test-daemon.sh` and `scripts/test-online.sh`; new files auto-route, so never hand-list files. Validate with `./scripts/test-daemon.sh --verify`.
- `check:test-quality` — rejects dead assertions (a test named for a mocked component that only checks `container.textContent`) and tests filed under a `describe` naming a function they never call.
- `check:raw-palette` — no new raw Tailwind palette classes (`bg-slate-500`, `text-white/50`, …) in `packages/web/src`; use theme tokens. Counts are capped per area by `scripts/raw-palette-baseline.json`.
- knip runs over the entry graphs in `knip.ts` with tests ignored. A new module that nothing imports fails CI, so a build slice must also export or register its module in the same PR.

## Style and critical constraints

- Biome: spaces, single quotes (double in JSX), semicolons, ES5 trailing commas, width 100.
- Zero comments in `.ts`/`.tsx` sources: no line, block, or JSDoc comments — enforced by `bun run check:no-comments` (CI). Exempt functional directives only: shebangs, `/// <reference>`, `@ts-*`, `biome-ignore`, `eslint-*`, `oxlint-*`, knip `@public`/`knip-ignore`, coverage ignores (`v8`/`istanbul`/`c8`).
- Oxlint rejects explicit `any`, unused variables, and `console.*` in application code. Entry points and tests are exempt; conditional startup logging uses `const logInfo = verbose ? console.log : () => {};`.
- Make surgical changes: preserve surrounding idioms and avoid unrelated cleanup.
- For new work in `packages/daemon` and `packages/web`, business logic paths compose as ONE direct superpipe pipeline (ADR 0004, `docs/adr/0004-superpipe-pipelines.md`): named for the business operation, mixing decision/transform/effect stages; typed rejection cascades use gates sharing one `result:<name>` output (`{ value } | { reason }` arms, disjoint domains) with named dependencies and inputs instead of ctx objects, while boolean `!dep` halts remain valid for data-dependent early exits. Never hand-roll imperative gate cascades when a pipeline fits, and never pre-classify a flow as decision-vs-staged — compose directly; `decisionRun`/`stagedRun` are deprecated (wrong abstraction): existing usages migrate slice-by-slice, no new call sites. The exclusions (hot loops; owning state, loops, atomicity, resources) bar the pipeline from being the owner, not a module from consulting pipelines at its decision points (decide-owning hybrid).
- The daemon DB has a PID lock. Always provide a unique `DB_PATH` when running from a worktree.
- Daemon startup deletes `process.env.CLAUDECODE` so SDK subprocesses can launch inside Claude Code.
- Credential discovery in `packages/daemon/src/lib/credential-discovery.ts`: environment → `~/.claude/.credentials.json` → macOS Keychain → `~/.claude/settings.json` environment block.
- Online tests requiring credentials must fail when secrets are missing; do not add silent skip guards.

## Change decomposition procedure (ADR 0004)

Whenever decomposing a feature, refactor, removal, or change request into tasks/PRs, follow the slice ladder below. It is what keeps PRs small and reviewable — construction and integration rarely share a diff. Reference implementation: the external-events delivery redesign (issues #3013–#3027).

**Measure before cutting.** Slice budgets and slice counts come from reading the code, never from the description. Before decomposing, inspect the touched files, call sites, and existing test mass — for a re-slice, measure the mined branch with the three-dot diff against a freshly resolved `origin/dev` (fetch first — Space worktrees may lack the ref; never trust GitHub's displayed diff). Work against a size limit (~300 prod lines per PR; tests ride their slice) and let the count follow: if an honest measure says an imagined slice is a multiple of the limit, it is multiple slices — the count is an output of measurement, not an input. The limit only ever splits work further; it never justifies bundling heterogeneous deliverables into one slice — slices are cut by purpose, never by size-fitting. Estimating from a description alone is the known root cause of PR expansion.

1. **Pin** — characterization tests for existing behavior that must survive. Pin only what survives; never pin what a later slice deletes (those tests die with the code).
2. **Extract** — refactor existing logic into pure functions (verbatim moves, zero behavior change); existing suites pass unmodified. Equivalence pins (new ⟺ old classifier, new source ≡ old source) turn semantic changes into reviewable test diffs.
3. **Build** — new pure functions with tests; add ONE direct superpipe pipeline per business path **where a pipeline fits** (per-stage tests) — additive, nothing calls them yet, but the module must be reachable from an entry graph (export or register it) or knip fails CI. Hot per-event loops and plain helper extractions stay plain functions (ADR 0004 exclusions).
4. **Wire** — integration last: single call-site swaps. Use a flag only when behavior genuinely changes and needs a staged rollout (then flip the default and later remove the flag); behavior-preserving rewires swap directly under their characterization pins.
5. **Delete** — removal-only PRs, zero new logic.

Standing rules for every slice:

- One issue, one purpose, one task, one PR. A slice is ONE deliverable — one pipeline, one module, one entry family, one wiring seam, one deletion set. If a slice's title needs a plus sign or a comma between heterogeneous things, it is multiple slices. A non-epic issue maps to exactly one Space task and one PR. When work outgrows that mapping, promote it to an epic (GitHub parent issue) and decompose into child issues — each child is 1:1:1 again. Never attach multiple tasks to a plain issue, and never multiple PRs to one task.
- Every PR targets `dev` directly — no stacked branches, no stacked PRs. Serial slices are ordered by the task dependency chain: each slice branches from updated `dev` after its dependency merges (rebase if `dev` advances mid-work). Never build on a sibling's unmerged branch — squash-merged stacks also corrupt size measurement (the diff double-counts the merged sibling).
- Construction, wiring, and deletion do not share a PR. Exception: a trivial build+wire combination is acceptable when the call-site swap is a few lines and the combined diff stays within the slice budget — when in doubt, split. Deletion never combines with anything.
- No polling while waiting: after opening a PR, subscribe to its events (PR-event subscriptions are part of the workflow contract) and act on deliveries — never poll PR state, CI checks, review comments, or mergeability on a timer or watch loop. One point-in-time verification read at an actual decision moment is allowed. When the next step is "wait for X", end the turn and go idle. This explicitly includes POST-MERGE: the post-approval job ends at merge + sync + audit + task completion — dev-branch CI results are NOT yours to watch; red dev arrives as an event to its owner.
- Time is a budget alongside size: a slice should reach its human checkpoint within ~90 minutes of starting (implementation + bot gate + CI). If its PR sits ~2 hours without merging, blocking, or reaching a checkpoint, the slice is stalled — report status and either re-plan or block; never leave a PR sitting idle. Waiting at the human checkpoint does not count against the slice.
- Every slice carries a **merge contract** in its task/issue description: one line naming what the PR may and may not touch (e.g. "additive dead code, no call-site changes"), plus separate prod and test line budgets (the ~300-per-PR limit is prod lines; tests ride their slice under their own cap). If the diff exceeds the budget or starts mixing phases, stop and report the overrun — in Space-managed work set the task to `blocked`; otherwise flag it in the PR — budgets are contracts, not suggestions.
- Reuse existing pipelines/gates where they fit; do not rebuild routing or decision logic a sibling already owns.

## Architecture

Design records live in `docs/adr/` (0001 live query + job queue, 0002 job-queue migration, 0003 data-defined workflow engine, 0004 superpipe pipelines, 0005 capability dispatcher, 0006 shared operations). `docs/architecture/` holds the RPC/MCP unification current/target/gap docs and the module decomposition program (verbatim extractions behind existing facades, ranked by cohesion, never by line count).

### Daemon and MessageHub

`DaemonApp` in `packages/daemon/src/app.ts` wires state/session/settings/auth/worktree managers, background jobs, and external-event extensions. Core backend areas are `agent/`, `providers/`, `session/`, `rpc-handlers/`, `operations/`, and `space/`.

MessageHub has three layers under `packages/shared/src/message-hub/`: `MessageHubRouter` (routing), `MessageHub` (protocol), and `WebSocketServerTransport` (I/O, in `packages/daemon/src/lib/websocket-server-transport.ts`). Initialize Router → MessageHub, then Transport → MessageHub.

SDK messages reach the web through LiveQuery `messages.bySession`; `SessionStore` applies snapshots/deltas and preserves optimistic messages with `pendingLocalMessageUuids`.

Storage is SQLite under `packages/daemon/src/storage/`: `schema/index.ts` owns `createTables` plus the numbered migrations `schema/mNNN-*.ts` (each exports `runMigrationNNN` and is imported and sequenced there); data access goes through `storage/repositories/`. The DB runs in WAL mode with a PID lock; the runtime seams (`sqlite-compat.ts`, `lib/runtime-server/`, `lib/runtime-spawn/`, `lib/runtime-hash.ts`) are what keep Bun and Deno both working — route new `Bun.*` usage through them rather than calling Bun APIs directly.

### Operations door (ADR 0006)

One transport-neutral operation per business path, defined once and called by RPC, MCP, and internal code alike:

- Operations live in `packages/daemon/src/lib/operations/` (registry, `invoke.ts` shared invoker, `rpc-adapter.ts`, `mcp-adapter.ts` + `mcp-server.ts`); Space task operations live in `space/operations/`. Each is `defineOperation({ name: 'task.cancel', inputSchema, resultSchema, execute(input, caller) })` with a stable dotted name and one direct superpipe pipeline inside.
- Humans reach operations through the `operation.invoke` RPC; agents through the `invoke` tool on the `hyperneo-operations` MCP server, which `QueryOptionsBuilder` attaches to every agent session. Adapters stay thin: envelope parsing, caller resolution, error mapping. Never implement a second transition, retry policy, or event sequence in an adapter or a typed tool.
- Domain rejections are result values (`{ accepted: false, reason }` with `*_unavailable` / `*_denied` / `*_unauthorized` families); throwing is reserved for infrastructure faults. Long-running work returns a durable acknowledgement (`{ accepted: true, jobId }`) and a job worker does the rest.
- Direction (amended 2026-09-14): `call_action`, the `ActionRegistry`, and the `space-actions` server from ADR 0005 are being retired; new agent-facing capability is an operation, not a new action or typed tool. Until the MCP pre-invocation pipeline resolves Space membership and role, operations whose admission is Space policy stay routed through `call_action` rather than entering the generic `invoke` catalog; only execution-ownership operations join it.

### Skills and MCP servers

Skills flow from the SQLite registry through `SkillsManager` into `QueryOptionsBuilder.build()`. Per-room overrides may disable globally enabled skills but do not independently enable them. Which MCP servers a session sees is decided by the app MCP registry plus enablement overrides (session > room > space > registry default); the SDK runs with `strictMcpConfig: true`, so nothing is auto-loaded from `.mcp.json`. See `docs/features/skills.md`.

Sessions with `session.context.spaceId` additionally receive the `space-actions` dispatcher (`call_action`) through `SpaceRuntimeService.attachSpaceToolsToMemberSession`; worker and task-agent sessions get it from `TaskAgentManager`. Use `AgentSession.mergeRuntimeMcpServers` so existing runtime MCPs survive. Authorization and autonomy gates belong in tool handlers and admission stages, never in prompts.

### Space runtime

Important seams under `packages/daemon/src/lib/space/`:

- `runtime/` — task/workflow execution and persistent delivery
- `agents/` — worker, custom, and long-horizon agents
- `goals/` — rolling goals, check-ins, and automation
- `workflows/` and `managers/` — workflow definitions and lifecycle
- `actions/` — the ADR 0005 dispatcher (`call_action` registry, safety classes, telemetry)
- `operations/` — Space task operations (ADR 0006)
- `tools/` — Space tool pipeline and admission gates

A space owns a registry of git-repo workspaces (`space_workspaces`, with `spaces.workspace_path` kept as the immutable primary; see `docs/features/space-workspaces.md`). Tasks, goals, and sessions bind to one registered repo each, and all task→repo resolution flows through `resolveTaskWorkspace` in `space/runtime/spawn-slot-resolution.ts` — never hand-roll a space-root fallback beside it.

`buildCustomAgentTaskMessage` in `space/agents/custom-agent.ts` centrally injects runtime location, role, prior goal work, project context, and standing instructions. Workflow slot prompts must remain behavioral; do not duplicate peers, channels, gate IDs, or reviewer framing there.

Space goals use `space_goals` plus append-only `space_goal_events`. They store rolling summary, progress, metrics, next steps, task pointers, and optional check-in schedules. Check-ins create ordinary Space tasks. Forge scopes provide linked evidence/episode/lesson loops; they do not replace goal state.

Long-horizon agents are persistent Space actors rehydrated by `SpaceRuntimeService` and stored through `SpaceLongHorizonAgentRepository`. They may own goals/Forge scopes and have durable reminders and external-event subscriptions. Space autonomy uses numeric levels 1–5. Legacy `goals`, `mission_executions`, and `mission_metric_history` tables are not the model for new Space work.

### Web

`packages/web/src`: `islands/` are the top-level page regions, `components/` and `hooks/` sit beneath them, and `lib/` holds the signal stores (`session-store`, `space-store`, `entity-store`, `global-store`), `connection-manager`, the router, and superpipe pipelines (`connection-*-pipeline.ts`). Tests colocate in `__tests__/` folders next to the code and run under happy-dom.

## Testing details

- Daemon unit tests live under `packages/daemon/tests/unit/{1-core,2-handlers,4-space-storage,5-space}`; the directory decides the CI shard. Vitest preloads `tests/vitest.setup.ts`, aliases the SDK to `tests/sdk-mock.ts`, silences console, and never calls real APIs; bare `bun test` runs get the same isolation from `tests/unit/setup.ts` when preloaded.
- `packages/daemon/tests/online/` boots a real daemon per test. CI runs every module with `HYPERNEO_USE_DEV_PROXY=1`, which routes Anthropic traffic to the dev-proxy stub serving the mocks in `.devproxy/` and blanks real credentials; `real-api-tests.yml` runs selected modules against real provider keys. `scripts/test-online.sh <module>` prints a module's paths.
- `HYPERNEO_USE_DEV_PROXY=1` requires the dev proxy and must not silently fall back.
- Known flaky tests are registered in `flaky-tests.json` (retry, quarantine, fix-task policy). Register there rather than adding retries or skips in test bodies.
- E2E tests act through visible browser UI. Do not use `hub.request`, internal stores, or direct state mutation in test bodies. Infrastructure setup/teardown may use `hub.request`. Use `closeWebSocket()`/`restoreWebSocket()` rather than browser offline mode.
- Run one E2E file at a time with `make run-e2e TEST=...`; malformed-response/token-expiry scenarios belong in daemon integration tests.

## Git

`dev` is the protected default/release branch. All PRs target `dev`; never merge directly into it. Use conventional commit prefixes: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`. Releases are tags on `dev` (`docs/release-process.md`).

In a fresh worktree run `bun install --frozen-lockfile` before committing; the pre-commit format check runs the workspace Biome and fails on untouched files with a stale install.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

HyperNeo is a browser UI for the Claude Agent SDK: multi-session chat, provider/model switching, file/git operations, MCP servers, checkpoints, and Space multi-agent workflows.

- **Runtimes:** Bun 1.4.2 (pinned release runtime) and Deno 2.9.x for the daemon (`docs/supported-runtimes.md`). Plain Node is not supported.
- **Stack:** Hono + Claude Agent SDK + SQLite backend; Preact + Signals + Vite + Tailwind frontend (Preact conventions, not React APIs); custom MessageHub RPC/pub-sub over WebSocket.
- **Tests:** Vitest everywhere except messaging (Bun test) and E2E (Playwright). Daemon and shared tests import `bun:test` but run under Vitest through `packages/daemon/tests/bun-test-shim.ts`.
- **Dependencies:** exact version pins only; CI rejects `^`/`~`.

## Monorepo

`cli` (entry point + HTTP wrapper), `daemon` (backend, sessions, providers, persistence, operations, Space), `shared` (types, MessageHub protocol, `OPERATION_NAMES`), `messaging` (transport-independent contracts), `prompts`, `web` (Preact frontend), `ui` (component library), `skills` (bundled `SKILL.md` plugins, copied to `~/.hyperneo/skills/` at startup), `desktop` (Tauri), `e2e` (Playwright).

`packages/prompts/src/mod.ts` imports every `.md` with `with { type: 'text' }`; the attribute is mandatory (Bun silently renders attribute-less `.md` imports to HTML) and there is no generated registry. Aliases `@hyperneo/shared`, `@hyperneo/daemon`, `@hyperneo/ui`, and `@/*` resolve directly to source.

## Commands

```bash
make dev PORT=8484 DB_PATH=/tmp/hyperneo-$(basename $PWD).db   # always isolate the DB in a worktree
cd packages/daemon && DB_PATH=/tmp/hyperneo-deno-$(basename $(git rev-parse --show-toplevel)).db bun run dev:deno

bun run check          # no-comments, format, lint, types, knip, then the guards below
bun run lint:fix && bun run format
make setup-hooks       # pre-commit: lint, format check, typecheck, knip

./scripts/test-daemon.sh                  # all daemon + shared shards; add a shard name, --rerun, or --show-failures
cd packages/daemon && bun test tests/unit/some-test.test.ts     # never run `bun test` from the repo root
cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/convo/multiturn-conversation.test.ts
cd packages/web && bunx vitest run src/lib/__tests__/some.test.ts
make run-e2e TEST=tests/features/foo.e2e.ts

make build && make compile
```

Prefer unit/component tests; add E2E only when asked or when the behavior needs a browser.

## Quality guards

Repo-specific checks inside `bun run check`, all CI-enforced:

- `check:no-comments` — zero comments in `.ts`/`.tsx`. Exempt only: shebangs, `/// <reference>`, `@ts-*`, `biome-ignore`, `eslint-*`, `oxlint-*`, knip `@public`/`knip-ignore`, coverage ignores. Vendored `packages/shared/src/sdk/{sdk,sdk-tools}.d.ts` also retain only their generated `Upstream SDK documentation` pointer; `make sync-sdk-types` refreshes those pointers to the installed, documented upstream declarations.
- `check:session-guards` — only the allowlist in `scripts/check-session-deletion-callers.sh` may call session delete/archive primitives; anything else reopens a closed data-loss path.
- `check:operation-names` — every `defineOperation` name must be declared in `packages/shared/src/types/operation-names.ts`, and vice versa.
- `check:db-schema-parity` — `createSpaceTables` in `packages/daemon/tests/unit/helpers/space-test-db.ts` must match the migrated schema; update it with every migration that touches a table it covers.
- `check:test-matrix` / `check:online-shards` — every test file must land in exactly one CI shard. Shards are directory globs and hash buckets in `scripts/test-daemon.sh` and `scripts/test-online.sh`; never hand-list files.
- `check:test-quality` — rejects assertions that cannot fail against a mocked component, and tests filed under a `describe` naming a function they never call.
- `check:raw-palette` — no new raw Tailwind palette classes in `packages/web/src`; use theme tokens.
- knip ignores tests, so a module nothing imports fails CI. Export or register new modules in the same PR.

## Style and constraints

- Biome: spaces, single quotes (double in JSX), semicolons, ES5 trailing commas, width 100.
- Oxlint rejects explicit `any`, unused variables, and `console.*` in app code (entry points and tests exempt; startup logging uses `const logInfo = verbose ? console.log : () => {};`).
- Surgical changes only: preserve surrounding idioms, no unrelated cleanup.
- New daemon/web business logic composes as ONE direct superpipe pipeline per business path (ADR 0004, `docs/adr/0004-superpipe-pipelines.md`), named for the operation and mixing decision/transform/effect stages. Typed rejections are gates sharing one `result:<name>` output with disjoint `{ value } | { reason }` arms and named inputs, not ctx objects; `!dep` halts stay valid for data-dependent exits. Never hand-roll gate cascades where a pipeline fits; `decisionRun`/`stagedRun` are deprecated with no new call sites. Hot loops and resource-owning shells stay imperative and consult pipelines at decision points.
- The daemon DB has a PID lock; always pass a unique `DB_PATH` from a worktree.
- Daemon startup deletes `process.env.CLAUDECODE` so SDK subprocesses can launch inside Claude Code.
- Credential discovery (`packages/daemon/src/lib/credential-discovery.ts`): env → `~/.claude/.credentials.json` → macOS Keychain → `~/.claude/settings.json` env block.
- Tests that need credentials must fail when secrets are missing; no silent skip guards.

## Change decomposition (ADR 0004)

Measure before cutting: slice budgets and counts come from reading the touched code and call sites, never from the description. For a re-slice, measure with a three-dot diff against a freshly fetched `origin/dev`. The limit is ~300 prod lines per PR (tests ride their slice); the limit only splits work further, never bundles unrelated deliverables.

Ladder, one PR per rung: **Pin** (characterization tests for behavior that survives) → **Extract** (verbatim moves into pure functions, suites pass unmodified) → **Build** (new functions and pipelines with tests; nothing calls them yet, but they must be reachable for knip) → **Wire** (single call-site swaps; flags only for staged behavior changes) → **Delete** (removal only).

Rules for every slice:

- One issue, one purpose, one task, one PR. A title needing "and" or a comma is multiple slices; work that outgrows 1:1:1 becomes an epic with child issues.
- Every PR targets `dev` from updated `dev`; no stacked branches, never build on a sibling's unmerged branch.
- Construction, wiring, and deletion do not share a PR (a few-line build+wire is tolerable within budget; deletion never combines).
- No polling: subscribe to PR events and act on deliveries; one point-in-time read at a decision moment is fine. When the next step is "wait", end the turn. Post-merge work ends at merge + sync + audit + task completion; dev CI belongs to its owner.
- Reach a human checkpoint within ~90 minutes; a PR idle ~2 hours is stalled — report and re-plan or block.
- Each slice carries a merge contract (what it may touch, prod and test line budgets). Exceeding it means stop and report (`blocked` in Space work); budgets are contracts.
- Reuse existing pipelines and gates; never rebuild routing a sibling owns.
- Every PR description carries `Closes #<issue>` for its mapped issue, and the post-approval procedure verifies the issue actually closed after the squash-merge — close it manually with a comment referencing the squash commit if auto-close did not fire. A post-merge base mismatch caused by linear `dev` advancement (merge parent ≠ gated base) is informational, not a blocker: the gate binds to the PR head — record it in the merge audit and proceed.

## Architecture

ADRs in `docs/adr/` (0001 live query + job queue, 0002 job-queue migration, 0003 workflow engine, 0004 superpipe, 0005 capability dispatcher, 0006 shared operations). `docs/architecture/` holds the RPC/MCP unification docs and the module decomposition program.

**Daemon.** `DaemonApp` (`packages/daemon/src/app.ts`) wires managers, background jobs, and external-event extensions; core areas are `lib/agent` (SDK query runtime), `providers`, `session`, `session-resolution`, `rpc-handlers`, `operations`, the flat subsystem folders `tasks`, `workflows`, `messaging`, `goals`, `evolution`, `agents`, `workspaces`, `schedule`, and `space`. MessageHub layers under `packages/shared/src/message-hub/`: `MessageHubRouter` → `MessageHub` → `WebSocketServerTransport` (daemon-side); initialize in that order. SDK messages reach the web through LiveQuery `messages.bySession`; `SessionStore` subscribes, applies snapshot and delta events, and re-syncs on reconnect or `MESSAGE_TOO_LARGE`.

**Storage.** `packages/daemon/src/storage/schema/index.ts` owns `createTables` and sequences the numbered migrations `mNNN-*.ts`; data access goes through `storage/repositories/`. Bun/Deno dual support rests on the runtime seams (`sqlite-compat.ts`, `lib/runtime-server/`, `lib/runtime-spawn/`, `lib/runtime-hash.ts`); route new `Bun.*` usage through them.

**Operations door (ADR 0006).** One transport-neutral operation per business path. `packages/daemon/src/lib/operations/` holds the plumbing (registry, `invoke.ts`, catalog, discovery, RPC and MCP adapters); the operations themselves live in the subsystem that owns the path (`tasks/`, `messaging/`, …). Each is `defineOperation({ name, inputSchema, resultSchema, execute(input, caller) })` wrapping one pipeline. Humans call `operation.invoke` over RPC; agents call the `invoke` tool on the `hyperneo-operations` MCP server that `QueryOptionsBuilder` attaches to every session. Adapters stay thin; never implement a second transition or retry policy in an adapter or typed tool. Domain rejections are result values (`{ accepted: false, reason }`), throws are infrastructure faults, and long-running work returns `{ accepted: true, jobId }`. `call_action` and the `space-actions` server are gone (#4600); new agent capability is an operation. The `ActionRegistry` survives only as an adapter — `actionsAsOperations` (`space/actions/action-operations.ts`) folds its actions into a session's operation registry, so agents reach them through the same `invoke` tool. Caller role is resolved before invocation by `resolveSpaceMcpSessionPolicy` (`space/runtime/space-mcp-session-policy.ts`) into an `OperationCallerRole`.

**Skills and MCP.** Skills flow from the SQLite registry through `SkillsManager` into `QueryOptionsBuilder.build()`; room overrides can disable global skills but not enable them. MCP visibility is the app registry plus enablement overrides (session > space > default — room scope is not read by the resolver despite the schema still admitting it, see #4802); the SDK runs `strictMcpConfig: true`, so `.mcp.json` is never auto-loaded. Space agent sessions also get the `agent-memory` and `db-query` servers plus a Space-scoped operation registry via `SpaceRuntimeService.attachLongTermAgentMcpServersForSession` (workers via `TaskAgentManager`); use `AgentSession.mergeRuntimeMcpServers` so existing servers survive. Authorization and autonomy gates live in handlers and admission stages, never in prompts. See `docs/features/skills.md`.

**Space runtime** (`packages/daemon/src/lib/space/`): `runtime/` execution and delivery, `managers/`, `actions/` (the ADR 0005 registry, now surfaced as operations), `tools/` (tool pipeline and admission gates). Goals, workflows, tasks, and messaging are their own top-level subsystems (`lib/goals/`, `lib/workflows/`, `lib/tasks/`, `lib/messaging/`). Agent definitions (worker, custom, long-horizon, plus templates) are their own subsystem at `packages/daemon/src/lib/agents/` — not to be confused with `packages/daemon/src/lib/agent/` (singular), the SDK query runtime. A space owns registered git workspaces (`space_workspaces`, `docs/features/space-workspaces.md`); all task→repo resolution goes through `resolveTaskWorkspace` in `tasks/spawn-slot-resolution.ts`, never a hand-rolled fallback. `buildCustomAgentTaskMessage` (`agents/custom-agent.ts`) injects runtime location, role, prior goal work, and standing instructions; workflow slot prompts stay behavioral and must not duplicate peers, channels, gate IDs, or reviewer framing. Goals use `space_goals` plus append-only `space_goal_events`; check-ins create ordinary tasks; Forge scopes add evidence loops but do not replace goal state. Long-horizon agents are persistent actors rehydrated by `SpaceRuntimeService` and stored via `SpaceLongHorizonAgentRepository`. Autonomy is numeric 1–5. Legacy `goals`, `mission_executions`, and `mission_metric_history` are not the model for new work.

**Web** (`packages/web/src`): `islands/` are page regions, `components/` and `hooks/` beneath them, `lib/` holds the signal stores (`session-store`, `space-store`, `entity-store`, `global-store`), `connection-manager`, router, and `connection-*-pipeline.ts`. Tests colocate in `__tests__/` under happy-dom.

## Testing

- Daemon unit tests live in `tests/unit/{1-core,2-handlers,4-space-storage,5-space}`; the directory picks the shard. Vitest preloads `tests/vitest.setup.ts` and aliases the SDK to `tests/sdk-mock.ts`; bare `bun test` gets the same isolation with `--preload=./tests/unit/setup.ts`.
- `tests/online/` boots a real daemon. CI runs it with `HYPERNEO_USE_DEV_PROXY=1` (Anthropic traffic to the `.devproxy/` stub, real credentials blanked); `real-api-tests.yml` runs selected modules with real keys. The proxy flag must never fall back silently.
- Flaky tests are registered in `flaky-tests.json`, not patched with retries or skips.
- E2E acts through visible UI only: no `hub.request`, stores, or state mutation in test bodies (setup/teardown may use `hub.request`); use `closeWebSocket()`/`restoreWebSocket()`, not browser offline mode. Run one file at a time; malformed-response and token-expiry cases belong in daemon integration tests.

## Git

`dev` is the protected default and release branch; all PRs target it, releases are tags on it (`docs/release-process.md`). Conventional prefixes: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`. In a fresh worktree run `bun install --frozen-lockfile` before committing, or the pre-commit format check fails on untouched files.

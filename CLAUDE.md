# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

HyperNeo is a browser UI for the Claude Agent SDK: multi-session chat, provider/model switching, file/git operations, MCP servers, checkpoints, and Space multi-agent workflows.

- **Runtimes:** Bun 1.4.0 (pinned release runtime, root `package.json`) and Deno 2.9.x (supported alternative for the daemon; see `docs/supported-runtimes.md`)
- **Backend:** Hono, Claude Agent SDK, SQLite
- **Frontend:** Preact + Signals + Vite + Tailwind; use Preact conventions, not React-specific APIs
- **Transport:** custom MessageHub RPC/pub-sub protocol over WebSocket
- **Tests:** Bun (daemon/shared/cli), Vitest (web), Playwright (E2E)

## Monorepo

- `packages/cli` — `hyperneo` entry point and HTTP wrapper
- `packages/daemon` — backend, sessions, providers, persistence, Space orchestration
- `packages/shared` — shared types and MessageHub protocol
- `packages/messaging` — transport-independent messaging contracts
- `packages/prompts` — agent-facing prompts authored as markdown; `src/mod.ts` imports every `.md` at runtime via `with { type: 'text' }` (supported by both Bun and Deno) — there is no generated registry and no sync step; the attribute is mandatory (Bun silently renders attribute-less `.md` imports to HTML)
- `packages/web` — Preact frontend
- `packages/ui` — component library
- `packages/skills` — bundled skill plugins
- `packages/desktop` — Tauri shell
- `packages/e2e` — Playwright tests

Workspace aliases resolve directly to source: `@hyperneo/shared`, `@hyperneo/daemon`, and package-local `@/*`.

## Commands

```bash
# Development — always isolate the DB in a worktree
make dev PORT=8484 DB_PATH=/tmp/hyperneo-$(basename $PWD).db

# Daemon under Deno (dual support) — same DB isolation rule; needs `bun install` first
cd packages/daemon && DB_PATH=/tmp/hyperneo-deno-$(basename $(git rev-parse --show-toplevel)).db bun run dev:deno

# Quality
bun run check        # lint, types, knip, session/schema/test-quality guards
bun run lint:fix
bun run format

# Tests — never run `bun test` from repository root
./scripts/test-daemon.sh                  # all daemon shards
./scripts/test-daemon.sh 5-space-a # one shard
./scripts/test-daemon.sh --rerun
cd packages/daemon && bun test tests/unit/some-test.test.ts
cd packages/web && bunx vitest run src/some-test.test.ts
make run-e2e TEST=tests/features/foo.e2e.ts

# Build
make build
make compile
```

Prefer unit/component tests; add E2E coverage only when explicitly requested or the behavior genuinely requires browser-level validation.

## Style and critical constraints

- Biome: spaces, single quotes (double in JSX), semicolons, ES5 trailing commas, width 100.
- Zero comments in `.ts`/`.tsx` sources: no line, block, or JSDoc comments — enforced by `bun run check:no-comments` (CI). Exempt functional directives only: shebangs, `/// <reference>`, `@ts-*`, `biome-ignore`, `eslint-*`, `oxlint-*`, knip `@public`/`knip-ignore`, coverage ignores (`v8`/`istanbul`/`c8`).
- Oxlint rejects explicit `any`, unused variables, and `console.*` in application code. Entry points and tests are exempt; conditional startup logging uses `const logInfo = verbose ? console.log : () => {};`.
- Make surgical changes: preserve surrounding idioms and avoid unrelated cleanup.
- For new work in `packages/daemon` and `packages/web`, business logic paths compose as ONE direct superpipe pipeline (ADR 0004, `docs/adr/0004-superpipe-pipelines.md`): named for the business operation, mixing decision/transform/effect stages, `!dep` halts for early exits. Never hand-roll imperative gate cascades when a pipeline fits, and never pre-classify a flow as decision-vs-staged — compose directly; the existing `decisionRun`/`stagedRun` combinators may be used where they fit, but nothing requires choosing a category.
- The daemon DB has a PID lock. Always provide a unique `DB_PATH` when running from a worktree.
- Daemon startup deletes `process.env.CLAUDECODE` so SDK subprocesses can launch inside Claude Code.
- Credential discovery in `packages/daemon/src/lib/config.ts`: environment → `~/.claude/.credentials.json` → macOS Keychain → `~/.claude/settings.json` environment block.
- Online tests requiring credentials must fail when secrets are missing; do not add silent skip guards.

## Architecture

### Daemon and MessageHub

`DaemonApp` in `packages/daemon/src/app.ts` wires state/session/settings/auth/worktree managers, background jobs, and external-event extensions. Core backend areas are `agent/`, `providers/`, `session/`, `rpc-handlers/`, and `space/`.

MessageHub has three layers under `packages/shared/src/message-hub/`: `MessageHubRouter` (routing), `MessageHub` (protocol), and `WebSocketServerTransport` (I/O). Initialize Router → MessageHub, then Transport → MessageHub.

SDK messages reach the web through LiveQuery `messages.bySession`; `SessionStore` applies snapshots/deltas and preserves optimistic messages with `pendingLocalMessageUuids`.

### Skills and Space tools

Skills flow from the SQLite registry through `SkillsManager` into `QueryOptionsBuilder.build()`. Per-room overrides may disable globally enabled skills but do not independently enable them. See `docs/features/skills.md`.

Sessions with `session.context.spaceId` receive `space-agent-tools` through `SpaceRuntimeService.attachSpaceToolsToMemberSession`; `space_chat` and `space_task_agent` attach elsewhere. Use `mergeRuntimeMcpServers` so existing runtime MCPs survive. Authorization and autonomy gates belong in tool handlers.

### Space runtime

Important seams under `packages/daemon/src/lib/space/`:

- `runtime/` — task/workflow execution and persistent delivery
- `agents/` — worker, custom, and long-horizon agents
- `goals/` — rolling goals, check-ins, and automation
- `workflows/` and `managers/` — workflow definitions and lifecycle
- `tools/` — Space MCP servers

`buildCustomAgentTaskMessage` in `space/agents/custom-agent.ts` centrally injects runtime location, role, prior goal work, project context, and standing instructions. Workflow slot prompts must remain behavioral; do not duplicate peers, channels, gate IDs, or reviewer framing there.

Space goals use `space_goals` plus append-only `space_goal_events`. They store rolling summary, progress, metrics, next steps, task pointers, and optional check-in schedules. Check-ins create ordinary Space tasks. Forge scopes provide linked evidence/episode/lesson loops; they do not replace goal state.

Long-horizon agents are persistent Space actors rehydrated by `SpaceRuntimeService` and stored through `SpaceLongHorizonAgentRepository`. They may own goals/Forge scopes and have durable reminders and external-event subscriptions. Space autonomy uses numeric levels 1–5. Legacy `goals`, `mission_executions`, and `mission_metric_history` tables are not the model for new Space work.

## Testing details

- `packages/daemon/tests/unit/` preloads `setup.ts`, clears provider keys, and never calls real APIs.
- `packages/daemon/tests/online/` mocks the SDK by default; set `HYPERNEO_TEST_ONLINE=true` for real API coverage.
- `HYPERNEO_USE_DEV_PROXY=1` requires the dev proxy and must not silently fall back.
- E2E tests act through visible browser UI. Do not use `hub.request`, internal stores, or direct state mutation in test bodies. Infrastructure setup/teardown may use `hub.request`. Use `closeWebSocket()`/`restoreWebSocket()` rather than browser offline mode.
- Run one E2E file at a time with `make run-e2e TEST=...`; malformed-response/token-expiry scenarios belong in daemon integration tests.

## Git

`dev` is the protected default/release branch. All PRs target `dev`; never merge directly into it. Use conventional commit prefixes: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`.

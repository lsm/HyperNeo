# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

HyperNeo — browser UI for the Claude Agent SDK. Multi-session chat with model switching, file/git ops, MCP servers, rewind/checkpoints, and a Space/Mission system for multi-agent workflows.

## Stack

- **Runtime**: Bun 1.3.8+
- **Backend**: Hono + `@anthropic-ai/claude-agent-sdk`, SQLite
- **Frontend**: Preact + Signals + Vite + Tailwind (Preact automatic JSX runtime, **not React**)
- **Transport**: custom MessageHub protocol (RPC + pub/sub over WebSocket)
- **Tests**: Bun native (daemon/shared/cli), Vitest (web), Playwright (e2e)

## Monorepo

```
packages/cli      # `hyperneo` entry point, HTTP server wrapper
packages/daemon   # Backend: agent orchestration, sessions, RPC handlers
packages/shared   # Shared types, MessageHub protocol, provider abstractions
packages/web      # Preact frontend (islands, hooks, signals)
packages/ui       # Component library (Vite + Vitest)
packages/skills   # Bundled skill plugins (playwright, playwright-interactive)
packages/desktop  # Tauri shell
packages/e2e      # Playwright tests
```

`workspace:*` deps. Path aliases resolve to source (no build step):
- `@hyperneo/shared` → `packages/shared/src/mod.ts`, `@hyperneo/shared/*` → `packages/shared/src/*`
- `@hyperneo/daemon` → `packages/daemon/main.ts`, `@hyperneo/daemon/*` → `packages/daemon/src/*`
- `@/*` → package-local `./src/*`

## Commands

```bash
# Dev — ALWAYS pass DB_PATH in a worktree (see DB lock note below)
make dev PORT=8484 DB_PATH=/tmp/neokai-$(basename $PWD).db

# Quality
bun run check        # lint + typecheck + knip + check:session-guards
bun run lint:fix     # oxlint --fix
bun run format       # biome write

# Tests — never run `bun test` from repo root
./scripts/test-daemon.sh                # all daemon shards in parallel
./scripts/test-daemon.sh 5-space-runtime-a # one shard
./scripts/test-daemon.sh --rerun        # rerun previously failing files
cd packages/daemon && bun test tests/unit/some-test.test.ts
cd packages/web && bunx vitest run src/some-test.test.ts
make run-e2e TEST=tests/features/foo.e2e.ts   # self-contained, random port

# Build
make build           # web bundle
make compile         # binary for current platform
```

Don't add E2E tests for ordinary changes unless explicitly requested — prefer unit/component tests.

## Code style

- Biome: spaces, single quotes (double in JSX), semicolons, trailing commas (ES5), width 100
- Oxlint errors: `no-explicit-any`, `no-unused-vars`, `no-console`
- Knip checks dead exports
- **No `console.*` in app code.** Entry points (`main.ts`, `app.ts`, CLI) and tests are exempt via `.oxlintrc.json`. For verbose startup logs use `const logInfo = verbose ? console.log : () => {};`

## Agent discipline

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions above and below.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### Think before coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State assumptions explicitly when they affect the solution. If uncertain, ask.
- If multiple interpretations exist, present them; don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### Simplicity first

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No flexibility or configurability that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### Surgical changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't improve adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it; don't delete it.

When your changes create orphans:
- Remove imports, variables, and functions that your changes made unused.
- Don't remove pre-existing dead code unless asked.

Test: every changed line should trace directly to the user's request.

### Goal-driven execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass."
- "Fix the bug" → "Write a test that reproduces it, then make it pass."
- "Refactor X" → "Ensure tests pass before and after."

For multi-step tasks, state a brief plan:

```text
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria like "make it work" require clarification.

These guidelines are working if diffs have fewer unnecessary changes, fewer rewrites happen due to overcomplication, and clarifying questions come before implementation mistakes.

## Critical gotchas

- **DB lock**: daemon uses file-backed SQLite with a PID lock at `~/.hyperneo/data/daemon.db.lock`. A second daemon on the same DB fails fast. In worktrees, always pass `DB_PATH=/tmp/...`.
- **`process.env.CLAUDECODE` is deleted at daemon startup** so SDK subprocesses don't refuse to launch when the daemon itself runs inside a Claude Code session.
- **Credential discovery order** (`packages/daemon/src/lib/config.ts`): env vars → `~/.claude/.credentials.json` → macOS Keychain → `~/.claude/settings.json` env block.
- **Online tests with required credentials must hard-fail when secrets are missing** — do NOT add `if (!process.env.X) return` skip guards. CI is the contract.

## Architecture

### Daemon

`DaemonApp` (`packages/daemon/src/app.ts`) wires `StateManager`, `SessionManager`, `SettingsManager`, `AuthManager`, `WorktreeManager`. Subsystems live under `packages/daemon/src/lib/`: `agent/` (session lifecycle), `providers/` (Anthropic, GLM, Kimi, MiniMax, OpenRouter, Ollama, Gemini, codex/copilot bridges), `session/`, `rpc-handlers/`, `space/`, `room/` (legacy).

### MessageHub

Three layers in `packages/shared/src/message-hub/`:
1. `MessageHubRouter` — pure routing
2. `MessageHub` — protocol (owns Router + Transport)
3. `WebSocketServerTransport` — I/O (uses Router for client mgmt)

Init order: Router → MessageHub, then Transport → MessageHub.

LiveQuery `messages.bySession`: SDK messages stream via `liveQuery.subscribe`; frontend `SessionStore` applies snapshot + delta. Optimistic echo preserved via `pendingLocalMessageUuids`.

### Skills system

Skills (slash commands, plugins, MCP servers) configured globally; per-room overrides only **disable** globally-enabled skills. Flow: SQLite registry → `SkillsManager` → `QueryOptionsBuilder.build()` injects into SDK options at session init. Built-ins seeded on startup: `chrome-devtools-mcp`, `playwright`, `playwright-interactive`. See `packages/shared/src/types/skills.ts` and `packages/daemon/src/lib/agent/query-options-builder.ts`. User docs: `docs/features/skills.md`.

### Space runtime

Every session whose `session.context.spaceId` is set gets the `space-agent-tools` MCP server attached at startup via `SpaceRuntimeService.attachSpaceToolsToMemberSession` (uses `mergeRuntimeMcpServers` to preserve other runtime MCPs). `space_chat` and `space_task_agent` sessions are attached elsewhere — don't double-attach. All gating (writer auth, autonomy) lives inside the tool handlers.

### Space agent user message

Composed by `buildCustomAgentTaskMessage` (`packages/daemon/src/lib/space/agents/custom-agent.ts`):
1. `## Your Task` 2. `## Runtime Location` 3. `## Your Role in This Workflow` 4. `## Previous Work on This Goal` 5. `## Project Context` 6. `## Standing Instructions`

Slot prompts in `built-in-workflows.ts` must be **behavioral only** — peers, channels, gate IDs, and reviewer chrome are injected centrally. Re-stating them creates drift. Dev-mode warns when the final message exceeds 4 KB.

### Mission System (Goal V2)

Structured workflows on top of Space tasks. Implementation lives in `packages/daemon/src/lib/room/` for legacy DB compatibility (`goals`, `mission_executions`, `mission_metric_history` tables retained).

| Term | Value |
|---|---|
| Mission types | `one_shot`, `measurable`, `recurring` |
| Autonomy levels | `supervised` (default — PRs need human review), `semi_autonomous` (auto-complete) |

Use "mission" in new UI/API names; the table remains `goals`. Recurring missions create one `mission_executions` row per run with monotonic `executionNumber`.

## Test organization

- `packages/daemon/tests/unit/` — preloads `setup.ts` which sets `NODE_ENV=test`, clears all provider keys, suppresses console. Unit tests never call real APIs.
- `packages/daemon/tests/online/` — matrixized by module, mocks SDK by default, real API with `HYPERNEO_TEST_ONLINE=true`.
- `packages/e2e/tests/` — Playwright.

### Dev Proxy for online tests

`HYPERNEO_USE_DEV_PROXY=1` requires the dev proxy (no silent fallback). Clears `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN`, replaces `ANTHROPIC_API_KEY` with a dummy. Reused across tests by default (`HYPERNEO_DEV_PROXY_REUSE=1`). Verify with `tail .devproxy/devproxy.log` or `devproxy logs`.

### E2E rules

E2E tests are **pure browser interactions**. All actions through the UI; all assertions on visible DOM.

**Forbidden in test bodies**: `hub.request`, `hub.event`, `window.sessionStore`/`globalStore`/`appState`/`__stateChannels`, `connectionManager.simulateDisconnect()`, `page.context().setOffline()` (doesn't close WebSockets — use `closeWebSocket()` / `restoreWebSocket()` from `connection-helpers.ts`).

**Allowed infra-only**: session/space setup+teardown via `hub.request`, session-ID extraction in `waitForSessionCreated`, `waitForWebSocketConnected` fallback to hub state.

If a scenario can't be triggered through the UI (token expiry, malformed responses), it belongs in daemon integration tests, not E2E.

**Running**:
- `make run-e2e TEST=...` — self-contained, random port (recommended)
- `make self-test TEST=...` — runs against `make self` (port 9983)
- One file at a time; the full suite is too slow

`tmp/.dev-server-running` lock prevents accidental double-server starts; `make run-e2e` sets `E2E_PORT` so the lock check is skipped.

## Branching & CI

- **`dev`** is the default and release branch. All PRs target `dev`. Releases tag from `dev`.
- **Never merge directly to `dev`** — protected branch.

| Event | Tests |
|---|---|
| PR → `dev` | lint, typecheck, unit, integration |
| Push to `dev` | + web tests, CLI tests, build |
| `workflow_dispatch` | + E2E |

## Commits

Conventional: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`.

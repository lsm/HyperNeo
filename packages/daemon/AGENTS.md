# Server rules

For `packages/daemon` and `packages/space`. The root `AGENTS.md` still applies.

## Runtime

- Startup must delete `process.env.CLAUDECODE` so SDK subprocesses can launch inside Claude Code.
- Credential discovery reads env, then `~/.claude/.credentials.json`, macOS Keychain, then the env block in `~/.claude/settings.json`.
- Startup logging uses `const logInfo = verbose ? console.log : () => {};`.
- Route new `Bun.*` calls through the SQLite, server, spawn or hash runtime seams.
- Initialize `MessageHubRouter`, then `MessageHub`, then `WebSocketServerTransport`.

## Pipelines

- Decisions are pure functions over recorded facts; effects (DB writes, sends, spawns) sit at the pipeline's edges. A multi-step effect must leave consistent recorded state whichever step fails.
- Typed rejection gates share one `result:<name>` output with disjoint `{ value } | { reason }` arms.
- Use named inputs, not ctx objects; `!dep` halts may exit based on data.
- Do not hand-roll gate cascades where a pipeline fits.
- Do not add `decisionRun` or `stagedRun` calls; both are deprecated.
- Hot loops and resource-owning shells stay imperative; consult pipelines for decisions.

## Operations

- Use one transport-neutral `defineOperation` per business path, wrapping one pipeline.
- Humans use `operation.invoke` RPC; agents use `invoke` on `hyperneo-operations` MCP.
- Adapters/typed tools must not add another transition or retry policy.
- Domain rejections return `{ accepted: false, reason }`; infrastructure faults throw; long work returns `{ accepted: true, jobId }`.
- Resolve caller roles with `resolveSpaceMcpSessionPolicy` before invocation.
- Reach `ActionRegistry` through operations via `actionsAsOperations`.
- Keep authorization and autonomy checks in handlers and admission gates, never prompts.
- `check:operation-names`: `defineOperation` names must match `packages/shared/src/types/operation-names.ts` both ways.
- `check:session-guards`: only the `scripts/check-session-deletion-callers.sh` allowlist may delete/archive sessions.

## Neo

- Neo core vs packs: core (`packages/daemon/src/lib/neo/`) knows asks, todos, questions and workers only. Domain rules (pull requests, review, QA, life admin, ...) live in their pack under `lib/neo/packs/<pack>/` and reach core through the `NeoPack` hooks in `pack-contract.ts`; core never branches on a pack id or a domain concept.

## Skills, MCP and workspaces

- Room overrides may disable global skills, never enable them ([skills](../../docs/features/skills.md)).
- MCP visibility uses app registry + enablement (session > space > default); room scope is not read.
- Keep SDK `strictMcpConfig: true`; `.mcp.json` is not auto-loaded.
- Add MCP servers with `AgentSession.mergeRuntimeMcpServers` so existing servers survive.
- Use `resolveTaskWorkspace` for every task-to-repo lookup; never invent fallbacks.

## Goals

- Store goal state in `space_goals` with append-only `space_goal_events`.
- Goal check-ins create ordinary tasks; Forge adds evidence loops without replacing goal state.
- Autonomy is numeric, 1–5.

## Tests

- Credential-dependent tests must fail when secrets are missing; never silently skip.
- `check:db-schema-parity`: keep `createSpaceTables` in `packages/daemon/tests/unit/helpers/space-test-db.ts` aligned with migrations.
- `check:test-matrix` / `check:online-shards`: each test belongs to one shard via directory globs in `scripts/test-{daemon,online}.sh`, never hand-lists.
- Vitest loads `tests/vitest.setup.ts` and aliases the SDK to `tests/sdk-mock.ts`; direct `bun test` preloads `tests/unit/setup.ts`.
- Online tests boot a daemon. `HYPERNEO_USE_DEV_PROXY=1` routes Anthropic to `.devproxy/` with real credentials blanked; never silently fall back: `cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/convo/multiturn-conversation.test.ts`.
- `real-api-tests.yml` runs selected modules with real keys.

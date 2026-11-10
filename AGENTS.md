# AGENTS.md

HyperNeo uses the Claude Agent SDK. Use Preact conventions, not React APIs.
See [ADRs](docs/adr/) and [architecture](docs/architecture/) for design and layout.

## Runtime and setup

- Use Bun 1.4.2 for the daemon and native proof jobs ([runtimes](docs/supported-runtimes.md)).
- Pin exact dependency versions; no `^` or `~`.
- Run `bun install --frozen-lockfile` in fresh worktrees before committing.
- Always pass a unique `DB_PATH` from a worktree; the DB has a PID lock.
- Startup must delete `process.env.CLAUDECODE` so SDK subprocesses can launch inside Claude Code.
- Credential discovery reads env, then `~/.claude/.credentials.json`, macOS Keychain, then the env block in `~/.claude/settings.json`.
- Credential-dependent tests must fail when secrets are missing; never silently skip.
- In `packages/prompts/src/mod.ts`, import every `.md` with `with { type: 'text' }`; Bun otherwise renders HTML.

## Commands

```bash
make dev PORT=8484 DB_PATH=/tmp/hyperneo-$(basename $PWD).db

bun run check
bun run lint:fix && bun run format
make setup-hooks

./scripts/test-daemon.sh  # accepts a shard name, --rerun, --show-failures
cd packages/daemon && bun test tests/unit/some-test.test.ts
cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/convo/multiturn-conversation.test.ts
cd packages/web && bunx vitest run src/lib/__tests__/some.test.ts

make build && make compile
```

Never run `bun test` from the repo root. Pre-commit checks lint, format, types and knip.

## Style and constraints

- Preserve idioms; make surgical changes, no unrelated cleanup.
- Biome uses spaces, single quotes (double in JSX), semicolons, ES5 trailing commas and width 100.
- Oxlint bans `any`, unused variables and app `console.*` (entry points/tests exempt). Startup logging uses `const logInfo = verbose ? console.log : () => {};`.
- Use ONE direct superpipe pipeline per daemon/web business path, named for its operation. Mix decisions, transforms and effects ([ADR 0004](docs/adr/0004-superpipe-pipelines.md)).
- Decisions are pure functions over recorded facts; effects (DB writes, sends, spawns) sit at the pipeline's edges. A multi-step effect must leave consistent recorded state whichever step fails.
- Record each fact once. Derive from the tables that already hold it instead of adding columns or tables that duplicate it.
- Neo core vs packs: core (`packages/daemon/src/lib/neo/`) knows asks, todos, questions and workers only. Domain rules (pull requests, review, QA, life admin, ...) live in their pack under `lib/neo/packs/<pack>/` and reach core through the `NeoPack` hooks in `pack-contract.ts`; core never branches on a pack id or a domain concept.
- Typed rejection gates share one `result:<name>` output with disjoint `{ value } | { reason }` arms.
- Use named inputs, not ctx objects; `!dep` halts may exit based on data.
- Do not hand-roll gate cascades where a pipeline fits.
- Do not add `decisionRun` or `stagedRun` calls; both are deprecated.
- Hot loops and resource-owning shells stay imperative; consult pipelines for decisions.

## Checks and tests

`bun run check` includes format, lint, types, knip and these guards:

- `check:no-comments`: no TS/TSX comments except shebangs, triple-slash references, `@ts-*`, `biome-ignore`, `eslint-*`, `oxlint-*`, knip `@public`/`knip-ignore` and coverage ignores. Vendored `packages/shared/src/sdk/{sdk,sdk-tools}.d.ts` also retain their generated `Upstream SDK documentation` pointer; refresh it with `make sync-sdk-types`.
- `check:session-guards`: only the `scripts/check-session-deletion-callers.sh` allowlist may delete/archive sessions.
- `check:operation-names`: `defineOperation` names must match `packages/shared/src/types/operation-names.ts` both ways.
- `check:db-schema-parity`: keep `createSpaceTables` in `packages/daemon/tests/unit/helpers/space-test-db.ts` aligned with migrations.
- `check:test-matrix` / `check:online-shards`: each test belongs to one shard via directory globs in `scripts/test-{daemon,online}.sh`, never hand-lists.
- `check:test-quality`: assertions must be able to fail against mocked components; call the function named in `describe`.
- `check:raw-palette`: use theme tokens, not new raw Tailwind palette classes in `packages/web/src`.
- knip ignores tests; export/register new modules in the same PR so production reaches them.
- Prefer unit/component tests. Use Vitest except for messaging, which uses Bun test.
- Vitest loads `tests/vitest.setup.ts` and aliases the SDK to `tests/sdk-mock.ts`; direct `bun test` preloads `tests/unit/setup.ts`.
- Online tests boot a daemon. `HYPERNEO_USE_DEV_PROXY=1` routes Anthropic to `.devproxy/` with real credentials blanked; never silently fall back.
- `real-api-tests.yml` runs selected modules with real keys.
- Register flaky tests in `flaky-tests.json`; do not add retries or skips.

## Change decomposition and Git

- Measure touched code and callers before slicing; never estimate from a brief.
- When re-slicing, use a three-dot diff against freshly fetched `origin/dev`.
- Keep PRs near 300 production lines; tests ride their slice. The limit only splits work, never bundles unrelated work.
- One PR per rung: Pin (preserve behavior in tests) → Extract (verbatim moves, tests unchanged) → Build (tested, reachable for knip, not called) → Wire (one call site; flags only for staged behavior) → Delete (removal only).
- Keep construction, wiring and deletion separate; only a few-line Build+Wire within budget is allowed.
- One issue, purpose, task and PR. Split titles needing “and” or a comma; growing scope needs an epic with child issues.
- Target `dev` from updated `dev`; no stacked branches or unmerged sibling branches.
- Commit/PR prefixes: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`.
- Do not poll PRs. Act on events; read once at decision points. End the turn when waiting.
- After merge, sync, audit and complete the task. Dev CI belongs to its owner.
- Reach a human checkpoint in ~90 minutes. A PR idle ~2 hours is stalled: report and re-plan or block.
- Each slice needs a merge contract: allowed changes, production/test budgets. If exceeded, stop and report.
- Reuse pipelines and gates; do not rebuild routing a sibling owns.
- Every PR body needs `Closes #<issue>`. After squash-merge verify closure; if needed, close it with a squash-commit comment.
- A merge-parent mismatch from advancing `dev` is informational: gates bind to the head. Record it in the audit.
- Releases are tags on protected `dev`; follow [the release process](docs/release-process.md).

## Operations and runtime boundaries

- Use one transport-neutral `defineOperation` per business path, wrapping one pipeline.
- Humans use `operation.invoke` RPC; agents use `invoke` on `hyperneo-operations` MCP.
- Adapters/typed tools must not add another transition or retry policy.
- Domain rejections return `{ accepted: false, reason }`; infrastructure faults throw; long work returns `{ accepted: true, jobId }`.
- Resolve caller roles with `resolveSpaceMcpSessionPolicy` before invocation.
- Reach `ActionRegistry` through operations via `actionsAsOperations`.
- Keep authorization and autonomy checks in handlers and admission gates, never prompts.
- Route new `Bun.*` calls through the SQLite, server, spawn or hash runtime seams.
- Initialize `MessageHubRouter`, then `MessageHub`, then `WebSocketServerTransport`.
- Use `messages.bySession` snapshots/deltas; re-sync on reconnect or `MESSAGE_TOO_LARGE`.
- Room overrides may disable global skills, never enable them ([skills](docs/features/skills.md)).
- MCP visibility uses app registry + enablement (session > space > default); room scope is not read.
- Keep SDK `strictMcpConfig: true`; `.mcp.json` is not auto-loaded.
- Add MCP servers with `AgentSession.mergeRuntimeMcpServers` so existing servers survive.
- Use `resolveTaskWorkspace` for every task-to-repo lookup; never invent fallbacks.
- SDK runtime locations come from the host system prompt, not workflow slot prompts.
- Workflow slot prompts describe behavior; do not duplicate peers, channels, gate IDs or reviewer framing.
- Store goal state in `space_goals` with append-only `space_goal_events`.
- Goal check-ins create ordinary tasks; Forge adds evidence loops without replacing goal state.
- Autonomy is numeric, 1–5.

## Agent notes

- Claude Code reads this file through the `CLAUDE.md` link; Codex reads it directly.
- Do not mechanically rename Claude/Anthropic SDK identifiers here; those names reflect the actual upstream SDK and project configuration.
- To prove a change works, follow the verify skill in `.claude/skills/verify/SKILL.md`.

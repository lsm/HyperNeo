# AGENTS.md

HyperNeo uses the Claude Agent SDK.
See [ADRs](docs/adr/) and [architecture](docs/architecture/) for design and layout.

## Area rules

This file holds the rules for every change. Before you edit inside one of these areas you MUST read its file first; Claude Code loads it when it first opens a file there, other agents open it themselves.

- `packages/daemon/AGENTS.md`: server code, also for `packages/space` — operations, pipelines, runtime seams, Neo core and packs, daemon tests.
- `packages/web/AGENTS.md`: web UI.
- `packages/prompts/AGENTS.md`: prompts.
- `packages/shared/AGENTS.md`: shared types and the vendored SDK typings.

## Setup and commands

- Use Bun 1.4.2 for the daemon and native proof jobs ([runtimes](docs/supported-runtimes.md)).
- Pin exact dependency versions; no `^` or `~`.
- Run `bun install --frozen-lockfile` in fresh worktrees before committing.
- Always pass a unique `DB_PATH` from a worktree; the DB has a PID lock.

```bash
make dev PORT=8484 DB_PATH=/tmp/hyperneo-$(basename $PWD).db

bun run check
bun run lint:fix && bun run format
make setup-hooks

./scripts/test-daemon.sh  # accepts a shard name, --rerun, --show-failures
cd packages/daemon && bun test tests/unit/some-test.test.ts
cd packages/web && bunx vitest run src/lib/__tests__/some.test.ts

make build && make compile
```

Never run `bun test` from the repo root. Pre-commit checks lint, format, types and knip.

## Every change

- Preserve idioms; make surgical changes, no unrelated cleanup.
- Use ONE direct superpipe pipeline per daemon/web business path, named for its operation. Mix decisions, transforms and effects ([ADR 0004](docs/adr/0004-superpipe-pipelines.md)).
- Record each fact once. Derive from the tables that already hold it instead of adding columns or tables that duplicate it.
- `bun run check` must pass. It runs format, lint, types, knip and the repo guards; each guard names what to fix.
- No TS/TSX comments except shebangs, triple-slash references, `@ts-*` and lint, knip or coverage ignore directives.
- Lint bans `any`, unused variables and app `console.*` (entry points/tests exempt).
- knip ignores tests; export/register new modules in the same PR so production reaches them.
- Prefer unit/component tests. Use Vitest except for messaging, which uses Bun test.
- Assertions must be able to fail against mocked components; call the function named in `describe`.
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

## Agent notes

- Claude Code reads each `AGENTS.md` through the `CLAUDE.md` link beside it; Codex reads the root one directly.
- Do not mechanically rename Claude/Anthropic SDK identifiers here; those names reflect the actual upstream SDK and project configuration.
- To prove a change works, follow the verify skill in `.claude/skills/verify/SKILL.md`.

# Plan: Improve Test Coverage to 80%

## Goal

Raise the Coveralls combined project coverage from the current enforced minimum of 30% to 80%, enforced in CI.

## Current State (April 2026)

- **CI gate**: `MIN_COVERAGE=30` in `.github/workflows/main.yml` — the actual gate is wrong; must be raised to 80 as the final step.
- **Coverage tracking**: Coveralls receives parallel uploads from 8 daemon unit shards + ~25 online module shards + 1 web upload, then merges them.
- **Vitest (web)**: `packages/web/vitest.config.ts` has NO `coverage.include` glob. Files never imported by any test are invisible to coverage. This is a structural gap that likely means the real web coverage is lower than it appears.
- **Bun (daemon/shared/cli)**: Bun has no native `all:true` / `coverage.include`. Files never imported by any test are silently excluded. The workaround is a dedicated `coverage.test.ts` per package that dynamically imports every source file.
- **UI package**: Has vitest + 34 tests but is NOT wired into CI coverage uploads. Adding it would help the aggregate number.
- **CLI package**: CI runs `bun test` WITHOUT `--coverage`; coverage is never uploaded to Coveralls.

## High-Level Approach

Coverage increases through two levers:

1. **Expose hidden files** (infrastructure changes) — Fix vitest and add Bun workaround so untested files register as 0% instead of being invisible. This immediately lowers the apparent coverage but gives an honest baseline.
2. **Write tests** — Systematically cover the high-line-count untested files across web, daemon, shared, and cli packages.

The 80% target is achievable because most of the codebase already has test counterparts; the gap is a mix of invisible files and a handful of large untested modules.

## Milestones

| # | Milestone | Description |
|---|-----------|-------------|
| 01 | **Coverage Infrastructure** | Fix vitest `coverage.include`, add Bun all-files workaround per package, verify CI flag-name uniqueness |
| 02 | **True Baseline Measurement** | Run coverage after infrastructure changes, document actual per-package percentages |
| 03 | **Web: Lib and Store Tests** | Test `room-store.ts`, `lobby-store.ts`, `parse-group-message.ts`, and other uncovered lib files |
| 04 | **Web: Component Tests** | Test the top untested components by line count: `RoomAgents`, `AgentTurnBlock`, `RoomSettings`, `FallbackModelsSettings`, `MessageInput`, etc. |
| 05 | **Web: Hook and Utility Tests** | Test `useChatComposerController`, `useSkills`, and remaining uncovered hooks/utils |
| 06 | **Daemon: Repository Tests** | Tests for the 4 untested repositories: `space-worktree-repository`, `skill-repository`, `space-task-report-result-repository`, `workspace-history-repository` |
| 07 | **Daemon: Core Service Tests** | Tests for `rpc-handlers/index.ts`, `daemon-hub.ts`, `github-service.ts`, `providers/registry.ts`, `providers/factory.ts`, coordinator agents |
| 08 | **Shared and CLI Coverage** | Add Bun coverage workaround for shared; add `--coverage` flag to CLI CI step; fill gaps in shared message-hub and provider modules |
| 09 | **CI Gate Update** | Raise `MIN_COVERAGE` from 30 to 80 in `.github/workflows/main.yml` after coverage is confirmed passing |

## Cross-Milestone Dependencies

```
01 (Infrastructure) --> 02 (Baseline) --> 03-08 (Tests) --> 09 (Gate)
```

- Milestones 03–08 can run in parallel after milestone 02.
- Milestone 09 must be the last commit — raising the gate before coverage is at 80% would break CI.
- Milestones 06 and 07 are daemon-focused; they share the same test shard patterns and helpers but can be written by independent coder agents.

## Total Estimated Tasks

Approximately 28 tasks across 9 milestones.

## Key Technical Constraints

1. **Do not write tests for `migrations.ts`** — This file (7,317 lines of raw SQL) is not unit-testable. The existing integration path covers it indirectly.
2. **Neo-related tests remain disabled** — The `**/neo-*.test.ts` pattern is excluded via `--path-ignore-patterns` in the test runner. Do not re-enable them; the underlying flakiness is unresolved.
3. **Bun all-files workaround**: Use `Bun.Glob` + dynamic import pattern (see milestone 01). The glob must exclude `.test.ts`, `.d.ts`, `index.ts` barrels, and the schema `migrations.ts`.
4. **Vitest `coverage.include`** (not `coverage.all`): `coverage.all` was removed in Vitest 4.0. Use `coverage.include: ['src/**/*.{ts,tsx}']` with appropriate excludes.
5. **Coveralls flag-name uniqueness**: Each parallel upload already uses a unique `flag-name` (e.g., `daemon-0-shared`, `daemon-online-<module>`, `web`). No collision risk currently; verify any new uploads get a new unique flag.

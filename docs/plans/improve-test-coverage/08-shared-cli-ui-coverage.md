# Milestone 08: Shared, CLI, and UI Coverage Expansion

## Goal

Fill coverage gaps in the `shared`, `cli`, and `ui` packages. After the Bun all-files workaround is in place (milestone 01), previously-invisible files will appear at 0%. This milestone targets the most impactful uncovered shared modules and ensures CLI tests upload coverage to Coveralls.

## Scope

| Package | Key uncovered files | Notes |
|---------|---------------------|-------|
| shared | `message-hub/router.ts` (431 lines), `api.ts` (951 lines), `provider/types.ts` | Large type/utility files |
| shared | `message-hub/channel-manager.ts`, `message-hub/types.ts` | Message hub gaps |
| cli | `src/dev-server.ts`, `src/prod-server.ts`, `src/prod-server-embedded.ts` | Server entry points (hard to unit test) |
| cli | `src/cli-utils.ts`, `src/skill-utils.ts` | Already tested — verify coverage |
| ui | (no Coveralls upload currently) | Optional: add vitest coverage + upload |

---

## Task 8.1: Write tests for shared message-hub router and channel-manager

**Agent type**: coder

**Description**

`message-hub/router.ts` (431 lines) and `message-hub/channel-manager.ts` have partial test coverage from existing tests, but the Bun all-files workaround will expose more gaps. This task targets the uncovered paths.

**Files to read first**

- `packages/shared/src/message-hub/router.ts`
- `packages/shared/src/message-hub/channel-manager.ts`
- `packages/shared/tests/message-hub-router.test.ts` (existing tests)
- `packages/shared/tests/message-hub.test.ts`

**Files to create or modify**

- Extend `packages/shared/tests/message-hub-router.test.ts` with additional test cases, OR
- Create `packages/shared/tests/message-hub-router-extended.test.ts`

**Subtasks**

1. Run `./scripts/test-daemon.sh 0-shared --coverage` to get the current coverage of `router.ts` and `channel-manager.ts` after milestone 01 is merged.
2. Identify uncovered branches (error paths, edge cases in message routing, unsubscribe paths).
3. Write focused tests for each uncovered branch.
4. For `channel-manager.ts`: test channel creation, subscription management, and cleanup on disconnect.
5. Aim for 75%+ line coverage on both files.

**Acceptance criteria**

- New tests cover previously-uncovered branches.
- Both files show at least 75% line coverage.
- All tests pass in the 0-shared shard.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01 (Bun workaround for shared package).

---

## Task 8.2: Write tests for shared provider module and API helpers

**Agent type**: coder

**Description**

`packages/shared/src/provider/` contains `index.ts`, `types.ts`, and `auth-types.ts`. The `api.ts` (951 lines) is a large file of type definitions and API schemas. These are mostly type-level files, but the provider logic files have testable behavior.

**Files to read first**

- `packages/shared/src/provider/index.ts`
- `packages/shared/src/provider/types.ts`
- `packages/shared/src/provider/auth-types.ts`
- `packages/shared/src/api.ts`

**Files to create**

- `packages/shared/tests/provider.test.ts`

**Subtasks**

1. For `provider/index.ts`: test any exported factory functions or type guards.
2. For `provider/types.ts` and `auth-types.ts`: these are primarily type definitions; create tests that import the types and validate any runtime type guard functions.
3. For `api.ts`: if it contains only type definitions with no runtime code, a single import test gets it into coverage. If it contains validators or parsers, test those.
4. Note: Pure type declaration files (`.d.ts` files) don't count toward coverage — only `.ts` files with runtime code need testing.

**Acceptance criteria**

- `packages/shared/tests/provider.test.ts` exists and passes.
- Provider source files show at least 60% line coverage (accounting for type-only files).
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01.

---

## Task 8.3: Add coverage for CLI server files

**Agent type**: coder

**Description**

The CLI has 6 source files. `cli-utils.ts` and `skill-utils.ts` already have tests (confirmed in milestone 01 setup). The server files (`dev-server.ts`, `prod-server.ts`, `prod-server-embedded.ts`) start HTTP listeners and are not directly unit-testable, but logic extracted from them (like config validation, route setup) can be tested.

**Files to read first**

- `packages/cli/src/dev-server.ts`
- `packages/cli/src/prod-server.ts`
- `packages/cli/src/prod-server-embedded.ts`
- `packages/cli/tests/cli-utils.test.ts` (for existing test patterns)

**Files to create**

- `packages/cli/tests/server-config.test.ts`

**Subtasks**

1. Read the three server files to identify any pure functions or configurable logic (e.g., middleware setup, port configuration, route handlers without side effects).
2. If there are extractable pure functions (e.g., `buildServerConfig`, `resolvePort`), test those.
3. If the server files are purely side-effectful entry points with no testable units, document this and rely on the `coverage.test.ts` workaround (from task 1.3) to at least register them at 0% rather than invisible.
4. Focus testing effort on any logic that is extractable; do not attempt to spin up real servers.

**Acceptance criteria**

- Either `server-config.test.ts` exists with meaningful tests, OR a documented decision is made that the server files are integration-only (not worth unit testing).
- CLI source files appear in coverage output (even at 0%) thanks to task 1.3.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Task 1.3 (CLI coverage workaround), Task 1.4 (CLI coverage in CI).

---

## Task 8.4: (Optional) Add UI package to CI coverage uploads

**Agent type**: coder

**Description**

The `ui` package has vitest configured and 34 test files, but its coverage is never uploaded to Coveralls. Adding a Coveralls upload step for the UI package will increase the aggregate coverage figure.

This task is marked optional because the UI package may already have good coverage (34 tests / 64 source files). Evaluate after milestone 02 baseline data is available.

**Files to modify**

- `.github/workflows/main.yml`
- `packages/ui/vitest.config.ts`

**Subtasks**

1. Check if `packages/ui/vitest.config.ts` already has `coverage.include`. If not, add it.
2. Add a `test-ui` job to `.github/workflows/main.yml` similar to the `test-web` job:
   - Run `vitest run --coverage` in `packages/ui`
   - Fix coverage paths with `sed`
   - Upload to Coveralls with `flag-name: ui`
3. Add `test-ui` to the `needs` list of `coveralls-finalize`.
4. Add `test-ui` to the `success/skipped` check in the final `all-tests-passed` job.

**Acceptance criteria**

- UI coverage is uploaded to Coveralls on each push to `dev`.
- The `coveralls-finalize` job includes the UI flag.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01 (vitest `coverage.include` pattern established), Milestone 02 (confirm UI coverage is worth including).

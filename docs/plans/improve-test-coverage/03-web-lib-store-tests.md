# Milestone 03: Web — Lib and Store Tests

## Goal

Write tests for the major uncovered lib and store files in `packages/web/src/lib/`. These are pure TypeScript modules (no JSX), making them the most straightforward web tests to write. The largest is `room-store.ts` (1,396 lines), which is partially covered by existing tests but has significant uncovered paths.

## Scope

Target files (all in `packages/web/src/lib/`):

| File | Lines | Priority |
|------|-------|----------|
| `room-store.ts` | 1,396 | High — but partially covered; focus on gaps |
| `lobby-store.ts` | 258 | High |
| `parse-group-message.ts` | 100 | Medium |
| `errors.ts` | 46 | Low |
| `role-colors.ts` | 21 | Low |
| `recent-paths.ts` | 61 | Medium |
| `task-constants.ts` | 29 | Low |
| `space-constants.ts` | 17 | Low |

---

## Task 3.1: Audit existing room-store tests and add coverage for uncovered paths

**Agent type**: coder

**Description**

`room-store.ts` (1,396 lines) already has multiple test files under `packages/web/src/lib/__tests__/` (e.g. `room-store-session-events.test.ts`, `room-store-create-session.test.ts`, `room-store-computed-signals.test.ts`, etc.). The goal is to audit coverage gaps and add tests for paths not yet covered.

**Files to read first**

- `packages/web/src/lib/room-store.ts`
- All existing `room-store-*.test.ts` files in `packages/web/src/lib/__tests__/`

**Files to modify or create**

- Add new test cases to the most appropriate existing `room-store-*.test.ts` file, OR
- Create `packages/web/src/lib/__tests__/room-store-missing-coverage.test.ts` for new scenarios.

**Subtasks**

1. Read `room-store.ts` to identify exported functions and state machine branches not covered by existing tests.
2. For each uncovered branch (look for error paths, edge cases in event handling, optional parameter branches), write a focused test.
3. Follow the existing test patterns: use `createMinimalDb()` from helpers, mock signals with `@preact/signals`, mock the `connection-manager`.
4. Aim for at least 70% line coverage of `room-store.ts` (from the baseline measurement).
5. Run `bun run coverage` in `packages/web` and verify coverage of `room-store.ts` has increased.

**Acceptance criteria**

- New tests cover previously-uncovered branches in `room-store.ts`.
- All new tests pass with `bun run coverage`.
- No regressions in existing room-store tests.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01 (vitest `coverage.include` must be in place to measure accurately), Milestone 02 (baseline data).

---

## Task 3.2: Write tests for lobby-store.ts

**Agent type**: coder

**Description**

`lobby-store.ts` (258 lines) is completely untested. It manages the lobby state, session listing, and connection state for unauthenticated/pre-room views.

**Files to read first**

- `packages/web/src/lib/lobby-store.ts`
- `packages/web/src/lib/__tests__/global-store.test.ts` (for store testing patterns)
- `packages/web/vitest.setup.ts`

**Files to create**

- `packages/web/src/lib/__tests__/lobby-store.test.ts`

**Subtasks**

1. Read `lobby-store.ts` to understand its exports, state shape, and side effects.
2. Mock any external dependencies (e.g., `connection-manager`, `api-helpers`) using `vi.mock()`.
3. Write tests for: initial state, state transitions, any exported actions/methods.
4. Aim for at least 70% line coverage of `lobby-store.ts`.
5. Run `bun run coverage` and verify the new file appears in coverage output.

**Acceptance criteria**

- `packages/web/src/lib/__tests__/lobby-store.test.ts` exists and passes.
- Coverage of `lobby-store.ts` is at least 70%.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01.

---

## Task 3.3: Write tests for parse-group-message.ts, errors.ts, role-colors.ts, recent-paths.ts, and constants files

**Agent type**: coder

**Description**

These are small, mostly-pure utility files that should be quick to test comprehensively.

**Files to read first**

- `packages/web/src/lib/parse-group-message.ts`
- `packages/web/src/lib/errors.ts`
- `packages/web/src/lib/role-colors.ts`
- `packages/web/src/lib/recent-paths.ts`
- `packages/web/src/lib/task-constants.ts`
- `packages/web/src/lib/space-constants.ts`

**Files to create**

- `packages/web/src/lib/__tests__/parse-group-message.test.ts`
- `packages/web/src/lib/__tests__/errors.test.ts` (or add to existing `aaa-errors.test.ts` if appropriate)
- `packages/web/src/lib/__tests__/role-colors.test.ts`
- `packages/web/src/lib/__tests__/recent-paths.test.ts`

**Subtasks**

1. For `parse-group-message.ts`: test with various input shapes (empty, single message, grouped messages, edge cases like undefined sender).
2. For `errors.ts`: test error type guards, error constructors, and any classification helpers.
3. For `role-colors.ts`: test that each role returns a valid CSS class string; test the default/fallback case.
4. For `recent-paths.ts`: test path recording, deduplication, and retrieval.
5. For constants files (`task-constants.ts`, `space-constants.ts`): since these are pure data, a single test that imports and asserts key constant values is sufficient to get them into coverage.
6. Aim for 90%+ coverage of each file (they are simple enough).

**Acceptance criteria**

- All test files exist and pass.
- Each target file shows at least 80% line coverage in the vitest report.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01.

# Milestone 3: Web Lib and Utility Tests

## Milestone Goal

Write tests for the uncovered web lib utility files. These are pure TypeScript/JavaScript
modules with no Preact component rendering — they can be tested with plain Vitest `describe`
/ `it` / `expect` calls, no `render()` needed. They should be the quickest tests to write
and will provide a solid coverage foundation.

## Testing Pattern

All tests in this milestone use Vitest with the happy-dom environment (already configured in
`vitest.config.ts`). No `@testing-library/preact` is needed.

Test file location convention: place test files as `<source-dir>/<source-name>.test.ts`
co-located next to the source, e.g., `packages/web/src/lib/errors.test.ts`.

## Scope

Source files targeted:
- `packages/web/src/lib/errors.ts`
- `packages/web/src/lib/lobby-store.ts`
- `packages/web/src/lib/parse-group-message.ts`
- `packages/web/src/lib/recent-paths.ts`
- `packages/web/src/lib/role-colors.ts`
- `packages/web/src/lib/space-constants.ts`
- `packages/web/src/lib/task-constants.ts`
- `packages/web/src/components/tools/ToolsModal.utils.ts`

## Tasks

---

### Task 3.1: Test errors.ts and role-colors.ts

**Agent type:** coder

**Description:**
Write tests for the two simplest lib files: `errors.ts` (error class hierarchy) and
`role-colors.ts` (lookup constant).

**Subtasks (ordered):**
1. Read `packages/web/src/lib/errors.ts` to understand the three exported classes:
   `ConnectionError`, `ConnectionNotReadyError`, `ConnectionTimeoutError`.
2. Create `packages/web/src/lib/errors.test.ts` with tests that:
   - Verify `ConnectionError` is an instance of `Error`.
   - Verify `ConnectionNotReadyError` is an instance of `ConnectionError`.
   - Verify `ConnectionTimeoutError` stores and exposes `timeoutMs`.
   - Verify `.name` property is set correctly on each class.
   - Verify the default message for `ConnectionNotReadyError`.
3. Read `packages/web/src/lib/role-colors.ts` to understand `ROLE_COLORS`.
4. Create `packages/web/src/lib/role-colors.test.ts` with tests that:
   - Verify the expected roles are present (`planner`, `coder`, `general`, `leader`, `human`,
     `system`, `craft`, `lead`).
   - Verify each entry has `border`, `label`, and `labelColor` string fields.
   - Spot-check specific values (e.g., `ROLE_COLORS.planner.border` contains `teal`).
5. Run `bun run coverage` from `packages/web` to confirm the new files hit 100%.
6. Create a feature branch `test/web-lib-utilities`, commit, and open a PR via `gh pr create`.

**Acceptance criteria:**
- `packages/web/src/lib/errors.test.ts` exists and all tests pass.
- `packages/web/src/lib/role-colors.test.ts` exists and all tests pass.
- Both source files show 100% line coverage in the Vitest text report.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 1 Task 1.1 (vitest config with `coverage.include`)

---

### Task 3.2: Test parse-group-message.ts

**Agent type:** coder

**Description:**
Write tests for `parse-group-message.ts`, which normalizes raw `SessionGroupMessage` objects
into typed `SDKMessage` values. This function has multiple branches (status, leader_summary,
rate_limited, model_fallback, JSON parse, invalid JSON).

**Subtasks (ordered):**
1. Read `packages/web/src/lib/parse-group-message.ts` to understand all branches.
2. Read an existing test file in `packages/web/src/` to understand vitest import patterns
   used in this project (e.g., `packages/web/src/islands/__tests__/Room.test.tsx`).
3. Create `packages/web/src/lib/parse-group-message.test.ts` with tests covering:
   - `msgType === 'status'` — returns a `status` typed SDKMessage with `text` and `_taskMeta`.
   - `msgType === 'leader_summary'` — returns a `leader_summary` typed message.
   - `msgType === 'rate_limited'` with valid JSON content — spreads parsed fields.
   - `msgType === 'rate_limited'` with invalid JSON — falls back to `{ text: content }`.
   - `msgType === 'model_fallback'` with valid JSON content.
   - `msgType === 'model_fallback'` with invalid JSON.
   - Valid JSON content for an unknown msgType — parses and injects `timestamp`.
   - Invalid JSON content for an unknown msgType — returns `null`.
   - Normalization: `messageType` field used when `type` is absent (and vice versa).
4. Run `bun run coverage` from `packages/web` and confirm `parse-group-message.ts` shows
   100% line coverage.
5. Commit to `test/web-lib-utilities` branch and push.

**Acceptance criteria:**
- `packages/web/src/lib/parse-group-message.test.ts` exists and all tests pass.
- 100% line coverage for `parse-group-message.ts`.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 1 Task 1.1

---

### Task 3.3: Test space-constants.ts, task-constants.ts, and recent-paths.ts

**Agent type:** coder

**Description:**
Write tests for three constant/utility lib files. Constants files need minimal tests — verify
exported values have the expected types and spot-check key values. `recent-paths.ts` may have
more logic if it manages a sorted list or filters.

**Subtasks (ordered):**
1. Read `packages/web/src/lib/space-constants.ts`, `packages/web/src/lib/task-constants.ts`,
   and `packages/web/src/lib/recent-paths.ts` to understand what each exports.
2. For `space-constants.ts`: create `space-constants.test.ts` verifying that exported
   constants are defined, have the correct types, and spot-check representative values.
3. For `task-constants.ts`: create `task-constants.test.ts` with similar spot-check tests.
4. For `recent-paths.ts`: create `recent-paths.test.ts` covering all exported functions.
   If it has mutable state (e.g., a signal or array), test that mutations and reads work
   correctly. Test edge cases (empty list, duplicate entries, max-size trimming).
5. Run `bun run coverage` from `packages/web` to confirm all three source files are covered.
6. Commit to `test/web-lib-utilities` branch.

**Acceptance criteria:**
- Three new test files exist and all tests pass.
- All three source files show >= 90% line coverage.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 1 Task 1.1

---

### Task 3.4: Test lobby-store.ts and ToolsModal.utils.ts

**Agent type:** coder

**Description:**
Write tests for `lobby-store.ts` (a signal-based state store that uses `connection-manager`
and `toast`) and `ToolsModal.utils.ts` (utility functions for the tools modal). `lobby-store.ts`
has external dependencies that must be mocked via `vi.mock()`.

**Subtasks (ordered):**
1. Read `packages/web/src/lib/lobby-store.ts` in full to understand its signals, computed
   values, and methods.
2. Read `packages/web/src/components/tools/ToolsModal.utils.ts` to understand exported
   utilities.
3. For `ToolsModal.utils.ts` (simpler): create `ToolsModal.utils.test.ts` next to the source
   file, testing all exported functions with representative inputs and edge cases.
4. For `lobby-store.ts`: create `packages/web/src/lib/lobby-store.test.ts` with:
   - `vi.mock('../../lib/connection-manager', ...)` to stub `connectionManager`.
   - `vi.mock('../../lib/toast', ...)` to stub `toast`.
   - Tests for initial signal values.
   - Tests for any computed signals (verify they derive correctly from base signals).
   - Tests for methods that update signals (verify signal value changes after method call).
   - Note: avoid testing WebSocket plumbing directly — focus on the signal state changes.
5. Run `bun run coverage` from `packages/web` to confirm both files are covered.
6. Commit to `test/web-lib-utilities` branch and open the PR.

**Acceptance criteria:**
- `packages/web/src/lib/lobby-store.test.ts` exists and all tests pass.
- `packages/web/src/components/tools/ToolsModal.utils.test.ts` exists and all tests pass.
- Both source files show >= 80% line coverage.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 1 Task 1.1

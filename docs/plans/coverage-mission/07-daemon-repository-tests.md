# Milestone 7: Daemon Repository and Logic Tests

## Milestone Goal

Write dedicated unit tests for daemon source files that lack their own test file or have
identified gaps in direct coverage. Based on exploration, the files confirmed to lack
dedicated test files are:
- `skill-repository.ts` (indirectly exercised by skills-manager tests, but no direct repo tests)
- `space-worktree-repository.ts` (no test file found)
- `workspace-history-repository.ts` (exercised only through workspace-handler integration)
- `llm-workflow-selector.ts` helpers: `buildSelectionPrompt` and `cleanIdResponse` (the
  integration test covers the LLM-call path via mocks but the pure helper functions are not
  directly unit-tested)

Note: `workflow-run-status-machine.ts`, `post-approval-merge-template.ts`, and
`node-agent-tool-schemas.ts` already have test files; do not duplicate those.

## Testing Pattern

All daemon tests use the Bun native test runner (`bun:test`). For repository tests:
- Create an in-memory `bun:sqlite` `Database`.
- Run schema setup using the appropriate helper. For storage repositories, use
  `createSpaceTables` from `packages/daemon/tests/unit/helpers/space-test-db.ts` or
  call `runMigrations` for the full schema.
- For repositories that need tables NOT in `createSpaceTables` (e.g., `skills`,
  `space_worktrees`, `workspace_history`, `neo_activity_log`), add the table DDL inline
  in the test file or extend the helper.

Example pattern:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MyRepository } from '../../../../src/storage/repositories/my-repository';

describe('MyRepository', () => {
  let db: Database;
  let repo: MyRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE ...`);
    repo = new MyRepository(db as any);
  });

  afterEach(() => {
    db.close();
  });

  it('inserts and retrieves a record', () => {
    repo.insert({ id: 'test-1', ... });
    const result = repo.get('test-1');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('test-1');
  });
});
```

## Scope

Source files targeted:
- `packages/daemon/src/storage/repositories/skill-repository.ts`
- `packages/daemon/src/storage/repositories/space-worktree-repository.ts`
- `packages/daemon/src/storage/repositories/workspace-history-repository.ts`
- `packages/daemon/src/lib/space/runtime/llm-workflow-selector.ts` (helper functions only)

## Tasks

---

### Task 7.1: Test SkillRepository

**Agent type:** coder

**Description:**
Write direct unit tests for `SkillRepository` using an in-memory SQLite database. The
existing `skills-manager.test.ts` exercises the manager layer but does not directly test the
repository's full method surface.

**Subtasks (ordered):**
1. Read `packages/daemon/src/storage/repositories/skill-repository.ts` in full.
2. Read `packages/daemon/tests/unit/4-space-storage/storage/space-repository.test.ts` to
   understand the test pattern used in this project.
3. Determine the DDL for the `skills` table. Check
   `packages/daemon/src/storage/schema/migrations/` for the migration that creates it or
   use `runMigrations` on a fresh in-memory DB.
4. Create `packages/daemon/tests/unit/4-space-storage/storage/skill-repository.test.ts`:
   - `findAll()` — returns empty array on empty table; returns all rows ordered by `created_at`.
   - `get(id)` — returns `null` for unknown id; returns the correct skill for a known id.
   - `getByName(name)` — returns `null` for unknown name; returns correct skill by name.
   - `findEnabled()` — returns only skills with `enabled = 1`.
   - `insert(skill)` — inserts a row and calls `reactiveDb.notifyChange('skills')`.
   - `update(id, fields)` — updates only the provided fields; ignores calls with empty
     `fields` (no DB write); calls `notifyChange`.
   - `setEnabled(id, enabled)` — toggles the flag; calls `notifyChange`.
   - `setValidationStatus(id, status)` — returns `true` on existing id, `false` on unknown;
     calls `notifyChange` only when a row changed.
   - `delete(id)` — returns `true` on deletion; returns `false` if id not found; calls
     `notifyChange` only on actual deletion.
5. Provide a mock `ReactiveDatabase` stub with a spy on `notifyChange`.
6. Run `bun test packages/daemon/tests/unit/4-space-storage/storage/skill-repository.test.ts`
   from the repo root with the `--preload` flag matching `test:unit` config.
7. Create feature branch `test/daemon-repositories`, commit, and open PR via `gh pr create`.

**Acceptance criteria:**
- `skill-repository.test.ts` exists and all tests pass.
- `skill-repository.ts` shows >= 90% line coverage when run with coverage enabled.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 2 baseline (to know current gap)

---

### Task 7.2: Test SpaceWorktreeRepository

**Agent type:** coder

**Description:**
Write direct unit tests for `SpaceWorktreeRepository`. This repository manages the mapping
between space tasks and their git worktrees, including TTL-based cleanup queries.

**Subtasks (ordered):**
1. Read `packages/daemon/src/storage/repositories/space-worktree-repository.ts` in full.
2. Determine the DDL for the `space_worktrees` table from the schema migrations or by
   searching for `CREATE TABLE space_worktrees` in the codebase.
3. Create `packages/daemon/tests/unit/4-space-storage/storage/space-worktree-repository.test.ts`:
   - `create(params)` — creates a record, returns the created record with generated `id`
     and `createdAt`.
   - `getByTaskId(spaceId, taskId)` — returns `null` for unknown pair; returns record for
     known pair.
   - `listBySpace(spaceId)` — returns empty array for unknown space; returns all records for
     a known space ordered by `created_at`.
   - `listSlugs(spaceId)` — returns the slug strings for a space; returns empty array for
     unknown space.
   - `markCompleted(spaceId, taskId)` — returns `true` and sets `completedAt` for an active
     task; returns `false` if already completed or task not found.
   - `listCompletedBefore(cutoffMs)` — returns only records whose `completed_at < cutoffMs`;
     does not return records with `completed_at IS NULL`.
   - `delete(spaceId, taskId)` — returns `true` on deletion; returns `false` if not found.
4. Run the test with the unit test preloader to confirm it passes.
5. Commit to `test/daemon-repositories` branch.

**Acceptance criteria:**
- `space-worktree-repository.test.ts` exists and all tests pass.
- `space-worktree-repository.ts` shows >= 90% line coverage.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 2 baseline

---

### Task 7.3: Test WorkspaceHistoryRepository

**Agent type:** coder

**Description:**
Write direct unit tests for `WorkspaceHistoryRepository`. This is a simpler repository with
CRUD operations for recently-used workspace paths.

**Subtasks (ordered):**
1. Read `packages/daemon/src/storage/repositories/workspace-history-repository.ts` in full.
2. Determine the DDL for `workspace_history` table. The table has an autoincrement `id`
   column used for stable ordering tiebreaks (visible in the `list()` query).
3. Create `packages/daemon/tests/unit/2-handlers/rpc/workspace-history-repository.test.ts`
   (or place under `4-space-storage/storage/` following the storage test convention):
   - `upsert(path)` — inserts a new path with `use_count = 1`; calling again increments
     `use_count` and updates `last_used_at`.
   - `get(path)` — returns `null` for unknown path; returns the row for a known path.
   - `list(limit)` — returns entries ordered by `last_used_at DESC`; respects the `limit`
     parameter; returns empty array when table is empty.
   - `list()` default limit — does not return more than 20 entries when table has many rows.
   - `remove(path)` — returns `true` on deletion; returns `false` for unknown path.
   - Ordering tiebreak: two entries with the same `last_used_at` are returned in insertion
     order (last inserted first), verifying the `ORDER BY last_used_at DESC, id DESC` clause.
4. Run the test and confirm it passes.
5. Commit to `test/daemon-repositories` branch.

**Acceptance criteria:**
- `workspace-history-repository.test.ts` exists and all tests pass.
- `workspace-history-repository.ts` shows >= 90% line coverage.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 2 baseline

---

### Task 7.4: Test llm-workflow-selector.ts helper functions

**Agent type:** coder

**Description:**
Write unit tests for the pure helper functions in `llm-workflow-selector.ts`:
`buildSelectionPrompt` and `cleanIdResponse`. These are exported but only exercised
indirectly in the existing integration test. Direct unit tests will give precise coverage
of the formatting logic and edge cases without involving the SDK mock.

The main exported function `selectWorkflowWithLlmDefault` involves async SDK calls and is
already covered by the integration test; this task focuses only on the two pure helpers.

**Subtasks (ordered):**
1. Read `packages/daemon/src/lib/space/runtime/llm-workflow-selector.ts` in full to
   understand `buildSelectionPrompt` and `cleanIdResponse`.
2. Note that `cleanIdResponse` is not currently exported — it may need to be exported or
   the test file must import the module and test via `buildSelectionPrompt`'s side effects.
   If possible, export `cleanIdResponse` for direct testing and add a comment explaining why.
3. Create `packages/daemon/tests/unit/5-space/runtime/llm-workflow-selector.test.ts`:
   For `buildSelectionPrompt`:
   - Returns a prompt string containing the task title and description.
   - Truncates task title at 1000 characters.
   - Truncates task description at 1000 characters.
   - Truncates workflow description at 240 characters.
   - Includes all workflow ids in the prompt.
   - Uses `(empty)` when task description is empty.
   - Uses `(no description)` when workflow description is empty.
   - Limits workflow tags to 8.
   For `cleanIdResponse` (if exported):
   - Returns the id as-is when the LLM response is clean (single token).
   - Strips leading/trailing backtick, quote, or single-quote wrapping.
   - Extracts the final token when response is `"id: some-workflow-id"`.
   - Returns `null` when the response is empty.
   - Returns `null` when the response is `"none"` (case-insensitive).
4. Run the tests and confirm they pass without triggering any SDK mock.
5. Commit to `test/daemon-repositories` branch and open/update the PR.

**Acceptance criteria:**
- `llm-workflow-selector.test.ts` exists and all tests pass with no SDK calls.
- The helper functions in `llm-workflow-selector.ts` show >= 90% line coverage combined
  across the new unit test and the existing integration test.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 2 baseline

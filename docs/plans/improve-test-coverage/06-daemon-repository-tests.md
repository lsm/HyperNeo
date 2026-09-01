# Milestone 06: Daemon — Repository Tests

## Goal

Write unit tests for the 4 daemon storage repositories that currently have no test files. These use the established repository testing pattern: create an in-memory SQLite database with `createSpaceTables()` (or the full schema), instantiate the repository, and exercise CRUD methods.

## Background: Repository Testing Pattern

The existing repository tests in `packages/daemon/tests/unit/4-space-storage/storage/` follow this pattern:

```typescript
import { Database } from 'bun:sqlite';
import { describe, test, expect, beforeEach } from 'bun:test';
import { createSpaceTables } from '../../helpers/space-test-db';
import { SomeRepository } from '../../../../src/storage/repositories/some-repository';

let db: Database;
let repo: SomeRepository;

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  repo = new SomeRepository(db);
});
```

Note: If `createSpaceTables` doesn't include the required tables for a specific repository, add the missing table DDL inline in the test file rather than modifying `space-test-db.ts` (to avoid side effects on other tests).

## Scope

| File | Lines | Shard |
|------|-------|-------|
| `storage/repositories/space-worktree-repository.ts` | 134 | 4-space-storage |
| `storage/repositories/skill-repository.ts` | 196 | 4-space-storage |
| `storage/repositories/space-task-report-result-repository.ts` | 130 | 4-space-storage |
| `storage/repositories/workspace-history-repository.ts` | 71 | 4-space-storage |

---

## Task 6.1: Write tests for space-worktree-repository.ts

**Agent type**: coder

**Description**

`space-worktree-repository.ts` (134 lines) manages workspace-level git worktree records associated with spaces.

**Files to read first**

- `packages/daemon/src/storage/repositories/space-worktree-repository.ts`
- `packages/daemon/tests/unit/4-space-storage/storage/space-repository.test.ts` (for DB setup patterns)
- `packages/daemon/tests/unit/helpers/space-test-db.ts` (to check if `space_worktrees` table is defined)

**Files to create**

- `packages/daemon/tests/unit/4-space-storage/storage/space-worktree-repository.test.ts`

**Subtasks**

1. Read the repository to identify all public methods.
2. Check if `space-test-db.ts` defines the `space_worktrees` table. If not, add the DDL inline in the test's `beforeEach`.
3. Write tests for: create, findById, findBySpaceId, update, delete (all CRUD methods present).
4. Test edge cases: not found returns null/undefined, duplicate insert throws, etc.
5. Run `./scripts/test-daemon.sh 4-space-storage` to confirm tests pass.

**Acceptance criteria**

- Test file exists at `packages/daemon/tests/unit/4-space-storage/storage/space-worktree-repository.test.ts`.
- All CRUD methods have at least one test each.
- Repository shows at least 80% line coverage.
- Tests pass in the shard runner.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01 (Bun all-files workaround so the repository appears in coverage).

---

## Task 6.2: Write tests for skill-repository.ts

**Agent type**: coder

**Description**

`skill-repository.ts` (196 lines) manages skill definitions (user-configured agent capabilities).

**Files to read first**

- `packages/daemon/src/storage/repositories/skill-repository.ts`
- `packages/daemon/tests/unit/4-space-storage/storage/settings-repository.test.ts` (similar shape)

**Files to create**

- `packages/daemon/tests/unit/4-space-storage/storage/skill-repository.test.ts`

**Subtasks**

1. Read the repository to understand the `skills` table schema and all public methods.
2. Set up the in-memory DB with the skills table DDL (check if `createSpaceTables` includes it; if not, add inline).
3. Write tests for: create skill, find by id, find all, update, delete.
4. Test any query methods (e.g., find by room_id, find enabled skills).
5. Test the uniqueness/constraint behavior if applicable.

**Acceptance criteria**

- Test file exists and passes in the 4-space-storage shard.
- `skill-repository.ts` shows at least 80% line coverage.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01.

---

## Task 6.3: Write tests for space-task-report-result-repository.ts and workspace-history-repository.ts

**Agent type**: coder

**Description**

Two smaller repositories. `space-task-report-result-repository.ts` (130 lines) stores results of automated task report evaluations. `workspace-history-repository.ts` (71 lines) tracks workspace access history.

**Files to read first**

- `packages/daemon/src/storage/repositories/space-task-report-result-repository.ts`
- `packages/daemon/src/storage/repositories/workspace-history-repository.ts`

**Files to create**

- `packages/daemon/tests/unit/4-space-storage/storage/space-task-report-result-repository.test.ts`

  Note: There is already a `space-task-report-result-repository_test.ts` (with underscore-test suffix, non-standard) — check if it contains tests or is a stub, and either extend it or create the standard-named file.

- `packages/daemon/tests/unit/4-space-storage/storage/workspace-history-repository.test.ts`

**Subtasks**

1. Check the existing `space-task-report-result-repository_test.ts` — if it has meaningful tests, read it for context; if it is empty/stub, create a new properly-named file.
2. For `space-task-report-result-repository.ts`: test create, findByTaskId, and any aggregation methods.
3. For `workspace-history-repository.ts`: test adding an entry, retrieving history, and any limit/order behavior.
4. Both repositories are small — aim for 90%+ coverage.

**Acceptance criteria**

- Both repositories have tests that pass in the shard runner.
- Each shows at least 85% line coverage.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01.

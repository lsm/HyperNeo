# Milestone 1 — Short ID Infrastructure

## Goal

Establish the foundation for the short ID system: a utility function, shared type definitions, a DB migration adding nullable `short_id` columns to `tasks` and `goals`, and a `short_id_counters` table scoped per room.

## Context

All entities (rooms, tasks, goals) currently use full UUIDs from `generateUUID()` in `packages/shared/src/utils.ts`. The new system needs:
- A `short_id_counters` table in SQLite for per-room, per-entity-type counters
- Nullable `short_id TEXT UNIQUE` columns on `tasks` and `goals`
- A `formatShortId(prefix, counter)` utility that produces readable strings like `t-42`, `g-7`
- A `resolveEntityId(input)` helper that returns the UUID given either a UUID or short ID

No existing data is migrated — short IDs are computed lazily on first access for old records.

## Tasks

---

### Task 1.1 — Add Short ID Types and Utility to Shared Package

**Description**: Add the `formatShortId` utility and `ShortIdPrefix` constants to `packages/shared/src/utils.ts`. Export from `packages/shared/src/mod.ts`. No DB changes in this task.

**Subtasks**:
1. Add `ShortIdPrefix` constants: `export const SHORT_ID_PREFIX = { TASK: 't', GOAL: 'g' } as const` — **do NOT include `ROOM: 'r'`**; room short IDs are out of scope for this goal and an unused export will trigger a Knip warning in `bun run check`
2. Add `formatShortId(prefix: string, counter: number): string` — returns `${prefix}-${counter}` (e.g., `t-42`)
3. Add `parseShortId(shortId: string): { prefix: string; counter: number } | null` — parses `t-42` back into prefix + counter; valid short IDs must match `/^[a-z]-(\d+)$/` where the counter is a positive integer; returns null for anything else
4. Add `isUUID(value: string): boolean` — returns true if value matches UUID v4 format (`/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`)
5. Export all new exports from `mod.ts`
6. Write unit tests in `packages/daemon/tests/unit/short-id/utils.test.ts` for `formatShortId`, `parseShortId`, `isUUID`. **Note on test location**: `packages/shared` has no test runner configured; following the project's existing pattern for shared utility tests (which are tested from the daemon package), tests live in `packages/daemon/tests/unit/`. Check how existing `generateUUID` or other shared utils are tested and follow the same convention.

**Acceptance Criteria**:
- `formatShortId('t', 42)` returns `'t-42'`
- `parseShortId('t-42')` returns `{ prefix: 't', counter: 42 }`
- `parseShortId('t-abc')` returns `null` (non-numeric counter)
- `parseShortId('t-')` returns `null` (empty counter)
- `parseShortId('t-0')` returns `null` (counter must be positive integer ≥ 1)
- `isUUID('04062505-780f-4881-a3be-9cb9062790fb')` returns `true`
- `isUUID('t-42')` returns `false`
- All utilities are exported from `@hyperneo/shared`
- `bun run check` passes (no Knip unused-export warnings)
- Unit tests pass

**Depends on**: Nothing

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

---

### Task 1.2 — DB Migration: Add short_id Columns and Counter Table

**Description**: Add a new DB migration (next sequential number after current highest migration) that:
1. Adds a `short_id TEXT` nullable column to the `tasks` table with a UNIQUE constraint
2. Adds a `short_id TEXT` nullable column to the `goals` table with a UNIQUE constraint
3. Creates a new `short_id_counters` table for per-room, per-entity-type monotonic counters

**Subtasks**:
1. Determine the next migration number by reading `packages/daemon/src/storage/schema/migrations.ts` (currently ends around migration 46 — check the file for the actual highest number)
2. Implement `runMigrationNN(db)` in `migrations.ts`:
   - `ALTER TABLE tasks ADD COLUMN short_id TEXT` (idempotent: wrapped in try/catch or checked with `PRAGMA table_info`)
   - `ALTER TABLE goals ADD COLUMN short_id TEXT` (idempotent)
   - Create `short_id_counters` table if not exists:
     ```sql
     CREATE TABLE IF NOT EXISTS short_id_counters (
       entity_type TEXT NOT NULL,
       scope_id TEXT NOT NULL,
       counter INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (entity_type, scope_id)
     )
     ```
3. Add `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_short_id ON tasks(short_id) WHERE short_id IS NOT NULL`
4. Add `CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_short_id ON goals(short_id) WHERE short_id IS NOT NULL`
5. Add the migration call in `runMigrations()` with a descriptive comment
6. Write a unit test that verifies the migration runs idempotently (running it twice does not error)

**Acceptance Criteria**:
- After migration, `tasks` has a `short_id TEXT` column (nullable, unique where not null)
- After migration, `goals` has a `short_id TEXT` column (nullable, unique where not null)
- `short_id_counters` table exists with `(entity_type, scope_id)` as PK
- Migration is idempotent — running twice does not throw
- Unit test passes

**Depends on**: Task 1.1 (for sequencing — types should exist before schema changes; the migration itself does NOT import `formatShortId` at runtime)

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

---

### Task 1.3 — Short ID Allocator Service

**Description**: Create `packages/daemon/src/lib/short-id-allocator.ts` — a service that atomically increments the per-scope counter and returns a new formatted short ID. This uses SQLite's atomic `UPDATE ... RETURNING` or a transaction pattern.

**Subtasks**:
1. Create `ShortIdAllocator` class in `packages/daemon/src/lib/short-id-allocator.ts`
2. Constructor takes `db: BunDatabase`
3. Implement `allocate(entityType: 'task' | 'goal', scopeId: string): string`:
   - Uses a SQLite transaction to atomically insert-or-increment the counter in `short_id_counters`
   - Returns `formatShortId(prefix, counter)` using the appropriate prefix from `SHORT_ID_PREFIX`
   - **`RETURNING` clause caveat**: `RETURNING` support in `bun:sqlite` has not been validated in this codebase (no existing uses found). The coder must first check whether `db.prepare('... RETURNING counter').get(...)` works with Bun's SQLite driver. If `RETURNING` is not supported or behaves unexpectedly, use the established project pattern instead: run `db.run(insertOrUpdate)` inside a transaction, then issue a separate `SELECT counter FROM short_id_counters WHERE entity_type = ? AND scope_id = ?` to read back the value. The transaction ensures atomicity regardless of which pattern is used.
   - Preferred SQL attempt: `INSERT INTO short_id_counters (entity_type, scope_id, counter) VALUES (?, ?, 1) ON CONFLICT(entity_type, scope_id) DO UPDATE SET counter = counter + 1 RETURNING counter`
   - Fallback if `RETURNING` doesn't work: wrap `INSERT ... ON CONFLICT ... DO UPDATE` + `SELECT counter` in a `db.transaction()`
4. Implement `getCounter(entityType: string, scopeId: string): number` — reads current counter without incrementing (useful for admin/debugging)
5. Export `ShortIdAllocator` from `packages/daemon/src/lib/short-id-allocator.ts`
6. Write unit tests covering: first allocation returns counter=1, second returns counter=2, concurrent allocations produce unique IDs, different scopes are independent

**Acceptance Criteria**:
- `allocate('task', roomId)` returns `'t-1'` on first call, `'t-2'` on second call for same scope
- `allocate('task', roomId1)` and `allocate('task', roomId2)` are independent (both can return `'t-1'`)
- Allocation is atomic (SQLite transaction ensures no duplicate counters)
- Unit tests pass

**Depends on**: Task 1.1, Task 1.2

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

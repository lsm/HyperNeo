# Milestone 2: Skills Registry Data Model and Backend

## Milestone Goal

Implement the `AppSkill` types in the shared package, the `SkillRepository` (SQLite), the `SkillsManager` service in the daemon, and all RPC handlers for CRUD operations. Persistence follows the established SQLite + repository pattern (same as `goal-repository.ts`). Input validation is enforced at the manager layer to prevent injection attacks.

## Tasks

---

### Task 2.1: AppSkill Types in Shared Package

**Agent type:** coder

**Description:**
Add the `AppSkill` type family and related interfaces to `packages/shared/src/` so they are available to both the daemon and the web UI.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Create `packages/shared/src/types/skills.ts` with:
   - `SkillSourceType = 'builtin' | 'plugin' | 'mcp_server'`
   - `BuiltinSkillConfig = { commandName: string }` — references a `.claude/commands/` slash command
   - `PluginSkillConfig = { pluginPath: string }` — absolute path to a local plugin directory
   - `McpServerSkillConfig = { appMcpServerId: string }` — references an existing `app_mcp_servers` entry by ID; avoids duplicating MCP server config that is already managed by the app-level MCP registry (`app-mcp-handlers.ts` / `AppMcpServersSettings.tsx`)
   - `AppSkillConfig = BuiltinSkillConfig | PluginSkillConfig | McpServerSkillConfig`
   - `SkillValidationStatus = 'pending' | 'valid' | 'invalid' | 'unknown'`
   - `AppSkill` interface: `{ id: string; name: string; displayName: string; description: string; sourceType: SkillSourceType; config: AppSkillConfig; enabled: boolean; builtIn: boolean; validationStatus: SkillValidationStatus; createdAt: string }`
   - `CreateSkillParams` (omit id, createdAt, builtIn)
   - `UpdateSkillParams` (partial of CreateSkillParams fields)
3. Export `AppSkill`, `SkillSourceType`, `CreateSkillParams`, `UpdateSkillParams` and all config types from `packages/shared/src/types/skills.ts`.
4. Re-export the new types from `packages/shared/src/mod.ts` (or the appropriate barrel file).
5. Run `bun run typecheck` to confirm no type errors.
6. Write unit tests in `packages/shared/src/types/skills.test.ts` — type guards, ensure discriminated union is correct.

**Acceptance criteria:**
- `packages/shared/src/types/skills.ts` exists with all types
- Types exported correctly from shared barrel
- `bun run typecheck` passes
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 1.2: Skills Registry Architecture Design"]

---

### Task 2.2: SkillRepository (SQLite) and SkillsManager

**Agent type:** coder

**Description:**
Implement the `SkillRepository` class (SQLite persistence) and `SkillsManager` service in the daemon. Persistence follows the existing `goal-repository.ts` pattern — a `skills` table in the HyperNeo SQLite database. `SkillsManager` enforces input validation for security-sensitive fields before persisting.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Create `packages/daemon/src/storage/repositories/skill-repository.ts` following the same pattern as `goal-repository.ts`:
   - `ensureTable()` — creates `skills` table with columns: `id TEXT PRIMARY KEY`, `name TEXT UNIQUE NOT NULL`, `display_name TEXT NOT NULL`, `description TEXT NOT NULL`, `source_type TEXT NOT NULL`, `config TEXT NOT NULL` (JSON), `enabled INTEGER NOT NULL DEFAULT 1`, `built_in INTEGER NOT NULL DEFAULT 0`, `validation_status TEXT NOT NULL DEFAULT 'pending'`, `created_at TEXT NOT NULL`
   - `findAll(): AppSkill[]` — synchronous, consistent with `AppMcpServerRepository` convention
   - `get(id: string): AppSkill | null`
   - `findEnabled(): AppSkill[]`
   - `insert(skill: AppSkill): void`
   - `update(id: string, fields: Partial<AppSkill>): void`
   - `setEnabled(id: string, enabled: boolean): void` — targeted UPDATE for enabled flag; calls `notifyChange('skills')`
   - `setValidationStatus(id: string, status: SkillValidationStatus): void` — targeted UPDATE for validation_status; calls `notifyChange('skills')`
   - `delete(id: string): void`
   - Use the shared `Database` instance from `packages/daemon/src/storage/database.ts`; do NOT open a separate DB file.
3. Create `packages/daemon/src/lib/skills-manager.ts` with class `SkillsManager`:
   - Constructor: `(repo: SkillRepository, appMcpServerRepo: AppMcpServerRepository)` — `appMcpServerRepo` is required for `validateSkillConfig()` (MCP ref check) and `initializeBuiltins()` (upsert backing app MCP entries)
   - `listSkills(): AppSkill[]`
   - `getSkill(id: string): AppSkill | null` — delegates to `repo.get(id)`
   - `addSkill(params: CreateSkillParams): AppSkill` — calls `validateSkillConfig()` first, then generates UUID, sets `createdAt`, `builtIn=false`
   - `updateSkill(id: string, params: UpdateSkillParams): AppSkill` — calls `validateSkillConfig()` on any updated config
   - `setSkillEnabled(id: string, enabled: boolean): AppSkill` — delegates to `repo.setEnabled()`; returns updated skill
   - `setSkillValidationStatus(id: string, status: SkillValidationStatus): void` — delegates to `repo.setValidationStatus()`; used by job handler
   - `removeSkill(id: string): boolean` — returns false if built-in or not found
   - `getEnabledSkills(): AppSkill[]`
   - `initializeBuiltins(): void` — upserts default built-in skills on startup; uses `appMcpServerRepo.getByName()` / `create()` to ensure backing app MCP entries exist for `mcp_server` type built-ins
   - **Private `validateSkillConfig(sourceType, config)`** — enforces:
     - `plugin`: `pluginPath` must be an absolute path (starts with `/`), must not contain `../`, must not be empty
     - `mcp_server`: `appMcpServerId` must be a non-empty string; the referenced `app_mcp_servers` entry must exist (validated via `this.appMcpServerRepo.get(appMcpServerId)` — throw if null)
     - `builtin`: `commandName` must be a non-empty string
     - Throw a descriptive `Error` on validation failure
4. Register `SkillRepository` and `SkillsManager` (passing both `skillRepo` and `appMcpServerRepo`) in `packages/daemon/src/app.ts`.
5. Run `bun run typecheck`.
6. Write unit tests in `packages/daemon/tests/unit/skills-manager.test.ts`:
   - Test CRUD operations with an in-memory SQLite DB (use `':memory:'` path in test setup)
   - Test that built-in skills cannot be removed
   - Test persistence across load cycles
   - Test `getEnabledSkills()` filtering
   - **Test all validation rules**: path traversal rejected; `appMcpServerId` referencing a non-existent app MCP server rejected; empty `commandName` rejected
   - Test that valid configs pass validation

**Acceptance criteria:**
- `SkillRepository` uses the shared SQLite DB, not a separate file
- `SkillsManager` enforces input validation with descriptive errors for invalid configs
- All CRUD operations work correctly
- Built-in skills are protected from deletion
- Unit tests pass, including all validation boundary cases
- `bun run typecheck` passes
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 2.1: AppSkill Types in Shared Package"]

---

### Task 2.3: Skills RPC Handlers

**Agent type:** coder

**Description:**
Add RPC handlers for Skills CRUD operations so the web UI can manage skills via MessageHub. Create `packages/daemon/src/lib/rpc-handlers/skills-handlers.ts` and register it in the daemon hub.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Add skill-related RPC method types to `packages/shared/src/api.ts`:
   - `skills.list` → `{ skills: AppSkill[] }`
   - `skills.get` → `{ id: string }` → `{ skill: AppSkill | null }`
   - `skills.add` → `{ params: CreateSkillParams }` → `{ skill: AppSkill }`
   - `skills.update` → `{ id: string; params: UpdateSkillParams }` → `{ skill: AppSkill }`
   - `skills.remove` → `{ id: string }` → `{ success: boolean }`
   - `skills.setEnabled` → `{ id: string; enabled: boolean }` → `{ skill: AppSkill }`
3. Create `packages/daemon/src/lib/rpc-handlers/skills-handlers.ts` implementing all handlers using `SkillsManager`.
4. Register `registerSkillsHandlers` in `packages/daemon/src/lib/rpc-handlers/index.ts`.
5. Ensure `SkillsManager` is passed through the app context to handlers.
6. Run `bun run typecheck`.
7. Write unit tests in `packages/daemon/tests/unit/rpc-handlers/skills-handlers.test.ts`:
   - Mock SkillsManager, test each handler's success and error paths.
   - Verify that validation errors from `SkillsManager.addSkill` are surfaced as RPC errors.

**Acceptance criteria:**
- All 6 RPC handlers implemented and registered
- API types defined in shared package
- Validation errors returned as proper RPC error responses (not crashes)
- Unit tests cover success and error cases
- `bun run typecheck` passes
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 2.2: SkillRepository (SQLite) and SkillsManager"]

---

### Task 2.4: LiveQuery Integration for the skills Table

**Agent type:** coder

**Description:**
Wire the `skills` table into the ReactiveDatabase and LiveQuery systems so that any mutation to global skills automatically pushes real-time updates to subscribed frontend clients. Covers only the `skills` table and the `skills.list` named query.

**Note on scope split**: The `skills.byRoom` named query (which JOINs `room_skill_overrides`) and the `RoomSkillOverrideRepository` reactive wiring are handled in Task 3.2, which creates that table. This prevents a circular dependency: Task 3.2 depends on Task 2.2 (which creates `skills`), so `room_skill_overrides` wiring must live in Task 3.2 or later — not here.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. **Reactive notifications for `SkillRepository`** — do NOT modify `reactive-database.ts` or `METHOD_TABLE_MAP`. Follow the exact pattern in `packages/daemon/src/storage/repositories/app-mcp-server-repository.ts`:
   - In `SkillRepository` constructor: accept `reactiveDb: ReactiveDatabase`; call `this.reactiveDb.notifyChange('skills')` at the end of every write method (`insert`, `update`, `delete`, `setEnabled`, `setValidationStatus`)
3. Add `skills.list` named query to `NAMED_QUERY_REGISTRY` in `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts`.

   Use the existing `mcpServers.global` (0-param at line ~209) as the structural template — same SELECT alias style, row mapper pattern, and ORDER BY convention.

   **`skills.list`** (0 params) — all global skills, ordered by `built_in DESC, created_at ASC`:
   ```sql
   SELECT id, name, display_name AS displayName, description,
          source_type AS sourceType, config, enabled, built_in AS builtIn,
          validation_status AS validationStatus,
          created_at AS createdAt
   FROM skills
   ORDER BY built_in DESC, created_at ASC
   ```
   Row mapper (`mapSkillRow`): parse `config` JSON blob (omit if NULL, same as `mapMcpServerRow` — spread into result only when non-null); coerce `enabled` and `builtIn` (integer → boolean).

4. Run `bun run typecheck`.
5. Write unit tests:
   - Test `skills.list` query returns correct rows for a seeded DB
   - Test `SkillRepository` calls `reactiveDb.notifyChange('skills')` on insert/update/delete/setEnabled/setValidationStatus

**Acceptance criteria:**
- `SkillRepository` calls `reactiveDb.notifyChange('skills')` after every write; `reactive-database.ts` is NOT modified
- `skills.list` registered in `NAMED_QUERY_REGISTRY` with correct SQL and row mapper
- Unit tests pass
- `bun run typecheck` passes
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 2.3: Skills RPC Handlers"]

---

### Task 2.5: Job Queue for Async Skill Validation

**Agent type:** coder

**Description:**
Implement a `SKILL_VALIDATE` job queue so that when a skill is added or updated, background validation runs asynchronously (checking that a plugin path exists and is accessible, or that an MCP server command is on PATH) without blocking the RPC response. Follows the `JobQueueProcessor` + `JobQueueRepository` pattern.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Add to `packages/daemon/src/lib/job-queue-constants.ts`:
   ```ts
   export const SKILL_VALIDATE = 'skill.validate';
   ```
3. Create `packages/daemon/src/lib/job-handlers/skill-validate.handler.ts`:
   - Payload: `{ skillId: string }`
   - Fetch the skill from `SkillsManager`; throw if not found
   - For `plugin` skills: check `fs.access(pluginPath)` — fail job if path is inaccessible
   - For `mcp_server` skills: check that the referenced `app_mcp_servers` entry (by `config.appMcpServerId`) exists via `AppMcpServerRepository.get(config.appMcpServerId)`; fail job if `null`
   - For `builtin` skills: no-op (always valid)
   - On success: return `{ valid: true, skillId }`
   - On failure: throw descriptive error (job processor will retry then mark dead)
4. Register the handler in `packages/daemon/src/app.ts`:
   ```ts
   jobProcessor.register(SKILL_VALIDATE, (job) => handleSkillValidate(job, skillsManager));
   ```
5. In `SkillsManager.addSkill()` and `SkillsManager.updateSkill()`: after persisting, enqueue a `SKILL_VALIDATE` job via `jobQueue.enqueue({ queue: SKILL_VALIDATE, payload: { skillId } })`.
6. The `validationStatus` field is already part of `AppSkill` (defined in Task 2.1) and the `skills` table DDL (defined in Task 2.2). The job handler updates it via `SkillsManager.setSkillValidationStatus(skillId, 'valid' | 'invalid')` on completion.
7. Run `bun run typecheck`.
8. Write unit tests in `packages/daemon/tests/unit/job-handlers/skill-validate.handler.test.ts`:
   - Test that a valid plugin path passes
   - Test that a non-existent plugin path fails (job throws)
   - Test that an `appMcpServerId` referencing a non-existent app MCP server fails (job throws)
   - Test that builtin always passes

**Acceptance criteria:**
- `SKILL_VALIDATE` queue constant defined
- Job handler implemented and registered in app
- `addSkill` / `updateSkill` enqueue a validation job after persist
- `validationStatus` field added to `AppSkill` type and reflected in `skills` table schema
- Unit tests pass
- `bun run typecheck` passes
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 2.2: SkillRepository (SQLite) and SkillsManager"]

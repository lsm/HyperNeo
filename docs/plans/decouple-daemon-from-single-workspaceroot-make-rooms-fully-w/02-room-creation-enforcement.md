# Milestone 2: Room Creation Enforcement

## Goal

Enforce that every room is created with an explicit `defaultPath`. Update the backend `room.create` handler, the frontend `CreateRoomModal`, Neo action tools, and add a backfill migration for existing rooms that have `defaultPath = null`.

## Scope

- `packages/daemon/src/lib/rpc-handlers/room-handlers.ts` -- remove auto-populate fallback
- `packages/web/src/components/lobby/CreateRoomModal.tsx` -- add workspace path input
- `packages/web/src/lib/lobby-store.ts` -- pass `defaultPath` through
- `packages/daemon/src/lib/neo/tools/neo-action-tools.ts` -- remove `workspaceRoot` fallback
- `packages/daemon/src/storage/` -- backfill migration
- `packages/daemon/tests/` -- update tests

---

### Task 2.1: Update room.create handler to require defaultPath

**Description**: Remove the auto-populate fallback in `room.create` handler (lines 52-54 of `room-handlers.ts`) that silently fills `allowedPaths` and `defaultPath` from `workspaceRoot`. Instead, validate that `defaultPath` is provided and is a valid absolute path. If `allowedPaths` is not provided, derive it as `[{ path: defaultPath }]`. Validate that `defaultPath` exists on the filesystem using `fs.existsSync`. Update the `setupRoomHandlers` function signature -- `workspaceRoot` parameter is still passed (other handlers may need it) but is no longer used for room creation fallback.

**Subtasks**:
1. In `room-handlers.ts` `room.create` handler, replace the auto-populate logic: require `params.defaultPath`, throw `Error('defaultPath is required when creating a room')` if missing.
2. Add filesystem existence check: `if (!existsSync(params.defaultPath)) throw new Error('defaultPath does not exist: ...')`.
3. Derive `allowedPaths` from `defaultPath` if not explicitly provided: `const allowedPaths = params.allowedPaths ?? [{ path: params.defaultPath }]`.
4. Use `validateWorkspacePath()` from `@hyperneo/shared` for format validation.
5. Update `packages/daemon/tests/unit/rpc/room-handlers.test.ts`: fix all test cases that create rooms with `defaultPath: undefined` to use a valid temp directory path instead. Add a new test case that verifies `room.create` throws when `defaultPath` is missing.
6. Run `make test-daemon` to verify all tests pass.

**Acceptance Criteria**:
- `room.create` throws a clear error when `defaultPath` is not provided.
- `room.create` throws when `defaultPath` does not exist on disk.
- `allowedPaths` is auto-derived from `defaultPath` when not explicitly provided.
- All existing daemon tests pass with updated fixtures.

**Dependencies**: Task 1.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.2: Update CreateRoomModal to collect workspace path

**Description**: Add a workspace path input field to `CreateRoomModal`. The field should be pre-populated with the daemon's `workspaceRoot` (available from `SystemState` via the global state channel). The field is required -- the form cannot submit without it. Use the shared `validateWorkspacePath()` for client-side validation.

**Subtasks**:
1. In `CreateRoomModal.tsx`, add a `workspacePath` state variable, initialized from the daemon's `workspaceRoot` obtained via `SystemState` (import from the appropriate signal/store).
2. Add an input field for workspace path before the background textarea, with label "Workspace Path" and helper text "Filesystem path for this room's workspace".
3. Add client-side validation using `validateWorkspacePath()` -- show inline error if path is empty or not absolute. **Note**: The frontend only validates format (non-empty, absolute). Filesystem existence is checked server-side only (`existsSync` in Task 2.1). If the path doesn't exist on disk, the user will see a backend RPC error on submit. No debounced path-existence check is needed — the backend error is sufficient UX for this case.
4. Update the `onSubmit` prop type and call to include `defaultPath: workspacePath`.
5. In `Lobby.tsx` and `lobby-store.ts`, update the `onSubmit` callback and `createRoom()` to pass `defaultPath` from the form. **Remove any placeholder `defaultPath` value** that Task 1.1 may have added to pass typecheck — replace it with the real form value wired from `CreateRoomModal`.
6. Update `packages/web/src/components/lobby/__tests__/` tests if any exist for `CreateRoomModal`.
7. Run `make test-web` to verify.

**Acceptance Criteria**:
- `CreateRoomModal` shows a "Workspace Path" input field, pre-populated with daemon `workspaceRoot`.
- Form submission includes `defaultPath` in the params.
- Client-side validation prevents empty or relative paths.
- Web tests pass.

**Dependencies**: Task 1.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.3: Update Neo action tools room creation

**Description**: Update `create_room` in `neo-action-tools.ts` to always pass an explicit `defaultPath`. Remove the fallback to `workspaceRoot` (lines 558-561). If the user does not provide `workspace_path` in the tool call, the tool should return an error asking for the path rather than silently using the daemon's workspace.

**Subtasks**:
1. In `neo-action-tools.ts`, update the `create_room` tool: make `workspace_path` (mapped to `args.workspace_path`) required. If not provided, return an error result: "workspace_path is required when creating a room".
2. Set `allowedPaths` and `defaultPath` exclusively from `args.workspace_path`.
3. Remove the `workspaceRoot` fallback in the `allowedPaths` and `defaultPath` derivation.
4. Update the tool's JSON schema description to indicate `workspace_path` is required.
5. Verify that `workspaceRoot` is still passed to the Neo tools constructor (it may be used by `get_system_info` in query tools) but is no longer used for room creation.
6. Add/update unit tests if they exist for Neo action tools.

**Acceptance Criteria**:
- `create_room` tool requires `workspace_path` and errors clearly when missing.
- No fallback to daemon `workspaceRoot` for room creation.
- Existing tests pass.

**Dependencies**: Task 1.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.4: Backfill migration for existing rooms with null defaultPath

**Description**: Add a database migration that backfills `defaultPath` for existing rooms where it is `NULL`. The migration should set `defaultPath` to the first entry in `allowedPaths` (parsed from the JSON column). If `allowedPaths` is also empty, the migration cannot auto-fix -- log a warning. This ensures all existing rooms have a `defaultPath` before fallback removal in Milestone 3.

**Subtasks**:
1. Add a new migration function in `packages/daemon/src/storage/schema/migrations.ts`. **Verify the next available number** by checking the last wired call in `runMigrations()` — at the time of writing it is `runMigration69`, so use `runMigration70`. If another PR has merged a migration since, use the next available number instead (the project uses a single monolithic migrations file with numbered functions — there is NO `migrations/` directory). The migration must follow the existing idempotency pattern: **guard with column/table existence checks** (e.g., check if any rooms still have `default_path IS NULL`; if none, return early). Do NOT use `PRAGMA user_version` — the codebase does not use it. See `runMigration68` and `runMigration69` for the canonical pattern. The migration:
   - Selects all rooms where `default_path IS NULL`.
   - For each, parses the `allowed_paths` JSON column and sets `default_path` to the first entry's `path`.
   - For rooms where both `default_path` and `allowed_paths` are null/empty, the migration sets `default_path` to a sentinel value `'__NEEDS_WORKSPACE_PATH__'` (since the migration is pure SQL and has no access to `Config`).
2. Wire `runMigration70` into the `runMigrations()` function by adding a call at the end of the function body (after `runMigration69`), with a descriptive comment — matching the existing unconditional-call pattern.
3. **Add a sentinel replacement startup hook** in `packages/daemon/src/app.ts`, immediately after the `runMigrations()` call. This hook:
   - Queries for rooms where `default_path = '__NEEDS_WORKSPACE_PATH__'`.
   - Replaces the sentinel with `config.workspaceRoot` (which is available at this point in the boot sequence).
   - If `config.workspaceRoot` is also undefined (Milestone 5), logs an error listing the affected room IDs. These rooms can be fixed via the existing `room.update` RPC — the user (or Neo tools) can set `defaultPath` explicitly after startup. The sentinel value is deliberately invalid (not a real path), so Milestone 3 guards (`if (!room.defaultPath) throw` and `existsSync` checks) will fail loudly on any operation against these rooms, surfacing the issue to the user rather than silently misbehaving.
   - This must run before any room operations to prevent Milestone 3 guards from throwing on sentinel paths (for rooms where `workspaceRoot` IS available).
4. Add a unit test that creates rooms with `defaultPath = null` (via direct DB insert), runs the migration, and verifies `defaultPath` is backfilled correctly for both cases (has allowedPaths, and has neither — sentinel case).
5. Add a unit test for the startup hook that verifies sentinel replacement with `workspaceRoot`.
6. Run `make test-daemon` to verify.

**Acceptance Criteria**:
- Migration backfills `defaultPath` from `allowedPaths[0].path` for rooms with null `defaultPath` but non-empty `allowedPaths`.
- Rooms with empty `allowedPaths` AND null `defaultPath` get the sentinel value `'__NEEDS_WORKSPACE_PATH__'`.
- Startup hook in `app.ts` (after `runMigrations()`) replaces sentinels with `config.workspaceRoot`. If `workspaceRoot` is undefined, logs an error with affected room IDs.
- Migration is idempotent (safe to run multiple times).
- Migration follows the existing monolithic pattern in `migrations.ts` (numbered function, wired into `runMigrations()`).
- Unit tests cover: backfill from allowedPaths, sentinel insertion, sentinel replacement at startup.
- Milestone 3 tasks depend on this task (sentinels are replaced before fallbacks are removed).

**Dependencies**: Task 2.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

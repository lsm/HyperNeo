# Decouple Daemon from Single workspaceRoot -- Make Rooms Fully Workspace-Self-Contained

## Goal

Remove the daemon's global `workspaceRoot` as the universal fallback for room-scoped workspace operations. After this work, every room carries its own `defaultPath` (required at creation), and all room-scoped operations (reference resolution, MCP config, session creation, runtime workspace) derive their workspace path exclusively from the room, not from the daemon.

## High-Level Approach

The work is split into six milestones, executed in dependency order:

1. **Shared types and validation** -- Make `defaultPath` required in `CreateRoomParams`, add validation helpers, and expose `workspaceRoot` to the frontend so it can pre-populate the field.
2. **Room creation flow (backend + frontend)** -- Enforce required `defaultPath` in `room.create` handler, update `CreateRoomModal` to collect workspace path (pre-filled from daemon `workspaceRoot`), update Neo tools, and backfill existing rooms.
3. **Eliminate workspaceRoot fallbacks in room-scoped paths** -- Fix `reference-handlers.ts`, `room-runtime-service.ts`, `session-lifecycle.ts`, and `settings-handlers.ts` to resolve workspace from the room's `defaultPath` instead of the daemon's `workspaceRoot`.
4. **Room.update defaultPath propagation** -- Allow changing `defaultPath` via `room.update` with guards (no active task groups), propagate to room chat session and runtime, handle the readonly `TaskGroupManager.workspacePath`.
5. **Make daemon workspaceRoot optional** -- Change `Config.workspaceRoot` to optional, audit all consumers, keep it only for DB path derivation and non-room sessions.
6. **Test coverage and E2E** -- Unit tests for all new validation/propagation logic, online tests for room creation with explicit paths, E2E test for the updated CreateRoomModal flow.

## Milestones

1. **Shared types and validation** -- Update `CreateRoomParams.defaultPath` to required, add path validation utility, expose `workspaceRoot` in `SystemState` (already done -- verify).
2. **Room creation enforcement** -- Backend `room.create` rejects missing `defaultPath`, frontend `CreateRoomModal` adds workspace path field, Neo action tools pass explicit paths, backfill migration for existing rooms.
3. **Eliminate workspaceRoot fallbacks** -- Fix `resolveSessionContext` in `reference-handlers.ts` to look up room `defaultPath`, fix `room-runtime-service.ts:638` fallback (includes `settings-handlers.ts` verification as subtask), fix `session-lifecycle.ts:93` to throw for room sessions, fix `session-manager.ts:437` `cleanupOrphanedWorktrees` fallback.
4. **Room.update defaultPath propagation** -- Guard `defaultPath` changes against active task groups, propagate to room chat session `workspacePath`, propagate to runtime (recreate `TaskGroupManager` or add mutable setter), update `room.updated` event handler in `RoomRuntimeService`.
5. **Make daemon workspaceRoot optional** -- Change `Config.workspaceRoot` to `string | undefined`, update `setupRoomHandlers` signature, update `FileIndex` to handle per-room paths or gracefully degrade, update `StateManager` and Neo query tools.
6. **Test coverage and E2E** -- Unit tests for required `defaultPath` validation, tests for fallback removal, tests for `room.update` propagation guards, E2E test for room creation with workspace path.

## Cross-Milestone Dependencies

- Milestone 2 depends on Milestone 1 (types must be updated first).
- Milestone 3 depends on Milestone 2 (rooms must have `defaultPath` before fallbacks can be removed).
- Milestone 4 depends on Milestone 3 (propagation logic builds on the new resolution paths).
- Milestone 5 depends on Milestones 3 and 4 (all room-scoped consumers must be fixed before `workspaceRoot` becomes optional).
- Milestone 6 runs in parallel with Milestones 2-5 (tests are written alongside each milestone but consolidated here for the E2E and integration pass).

## Key Sequencing Decisions

- **Backfill before removing fallbacks**: Existing rooms with `defaultPath = null` must be backfilled before fallback removal in Milestone 3. The migration (Task 2.4) uses the daemon's current `workspaceRoot` as the fallback value for rooms where both `defaultPath` and `allowedPaths` are null/empty — this is safe because the daemon currently provides it anyway.
- **Runtime recreation over mutable setter**: When `defaultPath` changes on a room, the runtime's `TaskGroupManager` is readonly. The plan opts to stop the runtime and recreate it rather than adding a mutable setter, which is safer and simpler. This is the committed approach — Task 4.2 must implement recreation, not a setter.
- **Hard breaking change for room.create**: Making `defaultPath` required is a hard break for any callers not providing it. This is intentional — all known callers (CreateRoomModal, Neo tools, tests) are updated in Milestone 2 before enforcement goes live. No deprecation window is needed since HyperNeo controls all clients.
- **FileIndex stays global for now**: Per-room file indexing is out of scope. `FileIndex` will continue using the daemon `workspaceRoot` (or become a no-op when it is unset). Room-scoped file search can be a follow-up.
- **SettingsManager stays singleton**: Rather than creating per-room `SettingsManager` instances, MCP config resolution for room chat sessions will read from the room's `defaultPath` directly using the existing filesystem utilities. The singleton `SettingsManager` remains for global/non-room settings. When `workspaceRoot` is undefined (Milestone 5), the global `SettingsManager` falls back to `homedir()`, meaning it reads MCP config from `~/.claude/.mcp.json` only — project-level `.mcp.json` files won't be discovered for the global instance. This is acceptable because room-scoped sessions use their own `defaultPath`.
- **DB path when workspaceRoot is undefined**: When `workspaceRoot` is not provided, the DB path defaults to `~/.neokai/data/daemon.db`. This is a dedicated default path (not shared with any workspace-derived path) so there is no collision risk. This only applies when the daemon is started without `--workspace`.
- **Sentinel rooms in a workspaceRoot-optional world**: After Milestone 5, a daemon with no `workspaceRoot` and legacy rooms that had null `defaultPath`+`allowedPaths` will retain the `__NEEDS_WORKSPACE_PATH__` sentinel. These rooms are in a degraded-but-non-fatal state: any operation against them will fail loudly (path validation rejects the sentinel), and they can be fixed via `room.update` RPC with an explicit `defaultPath`. No silent misbehavior occurs.
- **Cross-platform note**: `validateWorkspacePath` checks for absolute paths starting with `/` (POSIX only). HyperNeo currently targets macOS and Linux. Windows support is explicitly out of scope; the validation function documents this.

## Estimated Task Count

~20 tasks across 6 milestones.

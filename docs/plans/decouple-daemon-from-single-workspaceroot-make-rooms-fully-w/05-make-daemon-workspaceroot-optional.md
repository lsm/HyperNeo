# Milestone 5: Make Daemon workspaceRoot Optional

## Goal

Change `Config.workspaceRoot` from required to optional. The daemon can now start without a workspace path -- rooms provide their own. `workspaceRoot` remains used for: DB path derivation, non-room standalone sessions, `FileIndex` (graceful degradation), and `SystemState` broadcasting.

## Scope

- `packages/daemon/src/config.ts` -- make `workspaceRoot` optional
- `packages/daemon/src/app.ts` -- handle optional `workspaceRoot`
- `packages/daemon/src/lib/rpc-handlers/index.ts` -- pass optional to consumers
- `packages/daemon/src/lib/state-manager.ts` -- handle optional in broadcast
- `packages/daemon/src/lib/neo/tools/neo-query-tools.ts` -- handle optional
- `packages/shared/src/state-types.ts` -- make `workspaceRoot` optional
- Associated tests

---

### Task 5.1: Make Config.workspaceRoot optional and update daemon startup

**Description**: Change `Config.workspaceRoot` from `string` to `string | undefined`. Update `getConfig()` to not throw when no workspace is provided -- instead return `undefined`. Update `DaemonApp` creation in `app.ts` to handle optional `workspaceRoot`. The DB path derivation needs a fallback when `workspaceRoot` is undefined (use a default DB path or require explicit `--db-path`).

**Subtasks**:
1. In `config.ts`, change `workspaceRoot: string` to `workspaceRoot?: string` in the `Config` interface.
2. In `getConfig()`, replace the `throw new Error(...)` (line 76-79) with `workspaceRoot = undefined`. Update the `defaultDbPath` derivation to handle `undefined` -- if `workspaceRoot` is undefined, use `~/.hyperneo/data/daemon.db` as the default DB path. This is a dedicated path that does not collide with any workspace-derived DB path (which uses `encodeRepoPath()`). This only applies when the daemon is started without `--workspace`.
3. In `app.ts`, update `DaemonAppContext` creation to handle `config.workspaceRoot` being undefined. `SettingsManager` constructor at `settings-manager.ts:32` takes `private workspacePath: string` — this will fail to compile when `workspaceRoot` becomes `string | undefined`. Pass `config.workspaceRoot ?? homedir()` as the fallback. **Document this behavior explicitly in a code comment**: when no workspace is set, `SettingsManager` reads global MCP config from `~/.claude/.mcp.json` (the home directory), which means MCP servers configured in a project-level `.mcp.json` won't be discovered for the global instance. This is acceptable because room-scoped sessions use their own `defaultPath` for MCP resolution.
4. In `packages/daemon/src/lib/rpc-handlers/index.ts`, update all places that pass `deps.config.workspaceRoot` to handle `undefined`: `setupRoomHandlers` (already optional param), `RoomRuntimeService.defaultWorkspacePath` (already optional after Milestone 3), `FileIndex` constructor, `setupReferenceHandlers.workspaceRoot`, Neo tools. Also verify `SessionManager.cleanupOrphanedWorktrees` (already updated in Task 3.4 to require explicit path — confirm it no longer references `config.workspaceRoot` internally).
5. Update `FileIndex` to accept `undefined` root -- when undefined, `init()` is a no-op and searches return empty results. Add a guard at the top of `init()`. **There are two mandatory instantiation sites that must both be updated**:
   - `packages/daemon/src/app.ts:293`: `new FileIndex(config.workspaceRoot)` — update to pass `config.workspaceRoot` (now `string | undefined`).
   - `packages/daemon/src/lib/rpc-handlers/index.ts:294`: `new FileIndex(config.workspaceRoot)` — same update.
   Both must compile and work correctly when `workspaceRoot` is `undefined`. Missing either site will cause a runtime crash when the daemon starts without `--workspace`.
6. In `packages/shared/src/state-types.ts`, change `workspaceRoot: string` to `workspaceRoot?: string`. **Do this before subtask 7** so the type is optional before the broadcast is updated.
7. In `state-manager.ts`, broadcast `workspaceRoot: config.workspaceRoot` directly (let it be `undefined` — the type is now optional from subtask 6). Do NOT use `?? ''` — an empty string would cause the frontend to show an empty field instead of hiding it.
8. Update CLI entry points: `packages/cli/main.ts:53` and `packages/cli/prod-entry.ts:63` both log `config.workspaceRoot` at startup. Update to handle undefined gracefully (e.g., `config.workspaceRoot ?? '(none)'`).
9. In `session-lifecycle.ts`, add a guard for `baseWorkspacePath === undefined`: skip git-support detection (`detectGitSupport`) and worktree creation when no workspace path is available. This protects non-room sessions (e.g., `spaces_global`) that intentionally omit `workspacePath` and previously relied on `config.workspaceRoot` which is now `undefined`. Without this guard, `detectGitSupport(undefined)` will crash.
10. Update `neo-query-tools.ts` `get_system_info` to handle optional `workspaceRoot`.
11. Update all daemon tests that mock `Config` with `workspaceRoot` to continue working. No test should break -- they all provide explicit values.
12. Add a new test in `packages/daemon/tests/unit/core/config.test.ts` verifying the `workspaceRoot = undefined` code path: when neither `--workspace` flag nor `HYPERNEO_WORKSPACE_PATH` env var is set, `getConfig()` returns `workspaceRoot: undefined` and `defaultDbPath` falls back to `~/.hyperneo/data/daemon.db`.
13. Run `bun run typecheck && make test-daemon`.

**Acceptance Criteria**:
- Daemon can start without `--workspace` flag (using default DB path).
- `Config.workspaceRoot` is optional.
- `SystemState.workspaceRoot` is optional.
- `FileIndex` gracefully degrades when no `workspaceRoot`.
- `SettingsManager` is constructed with `config.workspaceRoot ?? homedir()` and this fallback behavior is documented in a code comment explaining MCP config implications.
- CLI entry points (`main.ts`, `prod-entry.ts`) handle undefined `workspaceRoot` gracefully in startup logs.
- All daemon tests pass.
- Type check passes across all packages.

**Dependencies**: Tasks 3.1, 3.2, 3.3, 4.2

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5.2: Update frontend to handle optional workspaceRoot

**Description**: Update the frontend to handle `SystemState.workspaceRoot` being optional. The `CreateRoomModal` pre-population should show an empty field when `workspaceRoot` is undefined. Any UI that displays `workspaceRoot` should show a fallback or hide the element.

**Subtasks**:
1. Search the web package for all references to `workspaceRoot` in `SystemState` or state subscriptions. Update them to handle `undefined`.
2. In `CreateRoomModal`, when `workspaceRoot` is undefined, leave the workspace path field empty instead of pre-populating.
3. In any status displays (e.g., `ConnectionStatus.tsx`, `GlobalStatus.tsx`) that show `workspaceRoot`, handle the undefined case gracefully (show "No default workspace" or hide the field).
4. Run `make test-web` to verify.

**Acceptance Criteria**:
- Frontend does not crash or show "undefined" when `workspaceRoot` is not set.
- `CreateRoomModal` workspace path field is empty when no daemon `workspaceRoot`.
- Web tests pass.

**Dependencies**: Task 5.1, Task 2.2

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

# Audit: MCP Integration with Session/Room Architecture

## Goal

Identify all gaps where MCP servers and skills are not properly integrated with the session, room, and space systems, then close those gaps with targeted code changes and tests.

## Audit Findings

### What Works (No Action Needed)

1. **Room chat sessions** (`room_chat` type) correctly receive MCP servers from three sources: file-based config, app-level registry (`AppMcpLifecycleManager`), and room-agent-tools. Skills are injected via `skillsManager` + `roomSkillOverrides` through `QueryOptionsBuilder`.

2. **Room worker sessions** (coder/general/planner) receive MCP servers from file-based + registry sources, merged in `RoomRuntimeService.createSessionFactory()`. Skills are injected via `skillsManager` + `roomSkillOverrides` passed through `AgentSession.fromInit()`.

3. **Session lifecycle**: MCP servers are stateless SDK configs (stdio command, SSE URL, HTTP URL), not persistent connections. The SDK manages the underlying MCP connections internally. There is no connect/disconnect lifecycle gap at the HyperNeo layer.

4. **Room-level skill overrides**: The `RoomSkillOverride` mechanism works correctly for rooms. Overrides can disable globally-enabled skills per room but cannot enable globally-disabled ones (by design).

### Gaps Found

| # | Gap | Severity | Location |
|---|-----|----------|----------|
| G1 | Space task agent sessions do not receive `skillsManager` or `appMcpServerRepo` in `AgentSession.fromInit()`, so skills (plugins + MCP server skills) are never injected via `QueryOptionsBuilder`. Note: `fromInit()` already accepts these as positional args 7 and 8 -- no signature change needed. | High | `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` (~line 304) |
| G2 | Space sub-sessions (node agents created by `createSubSessionFactory`) also lack skills injection via `AgentSession.fromInit()` | High | `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` (~line 444) |
| G3 | Space task agent rehydration (`rehydrateTaskAgent()`) calls `AgentSession.restore()` without `skillsManager`/`appMcpServerRepo`. After daemon restart, rehydrated task agent sessions run without skills injection even if freshly spawned ones have it. Sub-session rehydration (~line 1142) has the same issue. | High | `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` (~line 993, ~line 1142) |
| G4 | No per-space skill override mechanism exists (rooms have `RoomSkillOverride`, spaces have nothing equivalent) | Low | N/A (new feature) |
| G5 | After daemon restart, recovered room worker sessions lose both user-configured MCP servers (file-based + registry) AND skills injection (`skillsManager`/`appMcpServerRepo`). `AgentSession.restore()` does not accept these parameters. Only role-specific in-process MCP servers (planner-tools, leader-agent-tools) are restored. | Medium | `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` (~line 470), `packages/daemon/src/lib/agent/agent-session.ts` (~line 468) |
| G6 | **Missing `AppMcpServer.enabled` check in skills-based MCP injection.** `getMcpServersFromSkills()` in `QueryOptionsBuilder` calls `appMcpServerRepo.get(id)` but never checks `appServer.enabled` before adding the server to the SDK options map. It only checks `AppSkill.enabled` (via `getEnabledSkills()`). If an `AppMcpServer` is disabled but its wrapping `AppSkill` remains enabled, the server is still injected. The repository already has a `listEnabled()` method for this purpose. Note: normal sessions DO receive `skillsManager` and `appMcpServerRepo` through `SessionManager` and the skills injection path IS active at query-build time -- no additional `setRuntimeMcpServers()` call is needed for normal sessions. | High | `packages/daemon/src/lib/agent/query-options-builder.ts` (`getMcpServersFromSkills()` ~line 839-857) |
| G7 | **Project-level MCP server disable toggle not respected in room_chat sessions.** The ToolsModal writes disabled server names to `disabledMcpjsonServers` in `.claude/settings.local.json` via `settingsManager.setDisabledMcpServers()`. The SDK reads this key from the settings file. For normal/worker sessions this likely works because they load `settings.local.json`. However, `room_chat` sessions set `settingSources: []`, which causes the SDK to skip loading `settings.local.json` entirely -- so `disabledMcpjsonServers` never takes effect. Investigation is needed to confirm the exact affected session types and find the right fix (e.g., passing disabled servers through SDK options directly rather than relying on file-based settings). | High | `packages/web/src/components/ToolsModal.tsx`, `packages/daemon/src/lib/agent/query-options-builder.ts`, `packages/daemon/src/lib/settings-manager.ts` |
| G8 | **Tools UI in session chat container is outdated.** The ToolsModal shows "Claude Code Preset" toggle and "Settings Source" checkboxes (user/project/local) which are internal implementation details, not user-friendly concepts. App-level MCP servers (from the skills registry) are not shown at all -- only file-based MCP servers grouped by setting source appear. The UI needs a redesign to: show ALL available tools/prompts (file-based + app-level) organized into logical groups, and allow enable/disable at both group and individual level. | Medium | `packages/web/src/components/ToolsModal.tsx` (573 lines) |

**Previously reported as gap (confirmed not a gap):**

- ~~Space global agent session (`provisionGlobalAgent`) lacks skills injection~~ -- **False positive.** `provisionGlobalSpacesAgent()` creates sessions via `sessionManager.createSession()` / `sessionManager.getSessionAsync()`. The `SessionManager` factory already passes `skillsManager` and `appMcpServerRepo` to every `AgentSession` it constructs, so the global agent already receives skills injection. No action needed.

### Out of Scope

- The `builtin` skill sourceType (slash commands from `.claude/commands/`) is defined in types but not injected by `QueryOptionsBuilder`. This is documented and intentional -- not a gap.
- Hot-reload of MCP registry changes for short-lived worker/task sessions is intentionally deferred (changes take effect on next session creation).

## Approach

**Space agent gaps (G1-G3):** Thread `skillsManager` and `appMcpServerRepo` through space task agent creation and rehydration paths.

**Room recovery gap (G5):** Extend `AgentSession.restore()` to accept skills parameters and re-apply MCP server configs + skills during room worker session recovery.

**App-level MCP visibility (G6):** Ensure normal sessions properly surface app-level MCP servers, either by calling `setRuntimeMcpServers()` like other session types, or by fixing the skills-based injection path in `QueryOptionsBuilder`.

**MCP disable toggle bug (G7):** Trace the `disabledMcpServers` config from ToolsModal → session config → SDK options and fix wherever the chain breaks.

**Tools UI redesign (G8):** Redesign the ToolsModal to show all tools (file-based + app-level) in logical groups with group-level and individual enable/disable toggles. Remove internal concepts ("Claude Code Preset", "Settings Source") from the UI.

G4 (per-space skill overrides) is deferred as low priority -- spaces can be addressed later when the space system matures.

---

## Task 1: Inject skills into space task agent sessions and rehydration (G1 + G2 + G3)

**Description:** Pass `skillsManager` and `appMcpServerRepo` through the space `TaskAgentManager` so that both freshly created and rehydrated task agent sessions include skills injection. `AgentSession.fromInit()` already accepts these as positional args 7 and 8 -- no signature change needed. For rehydration, `AgentSession.restore()` currently does not accept these parameters, so its signature must be extended.

**Agent type:** coder

**Subtasks:**
1. Add `skillsManager` and `appMcpServerRepo` as **required** fields to the `TaskAgentManagerConfig` interface in `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`
2. Pass them as positional args 7 and 8 to `AgentSession.fromInit()` at ~line 304 (task agent creation) and ~line 444 (sub-session creation via `createSubSession()`)
3. Add `setRuntimeMcpServers()` call with `appMcpManager.getEnabledMcpConfigs()` for sub-sessions in `createSubSession()` (~line 444), matching the pattern used for main task agents (~line 376-388). Currently main task agents get registry MCPs via `setRuntimeMcpServers()` but sub-sessions do not.
4. Extend `AgentSession.restore()` signature (`agent-session.ts` ~line 468) to accept optional `skillsManager` and `appMcpServerRepo` parameters
5. Pass them through in `rehydrateTaskAgent()` (~line 993) and sub-session rehydration (~line 1142)
6. Update `packages/daemon/src/lib/rpc-handlers/index.ts` (~line 384, where `TaskAgentManager` is instantiated) to provide the new config fields from the daemon app context
7. Add unit tests verifying that `AgentSession.fromInit()` receives `skillsManager` and `appMcpServerRepo` when creating space task agent sessions
8. Add unit tests verifying that sub-sessions receive both skills injection AND `appMcpManager` registry MCPs via `setRuntimeMcpServers()`
9. Add unit tests verifying that rehydrated task agent sessions also receive skills injection
10. Add an online test confirming that a space task agent session has access to a globally-enabled MCP server skill
11. Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Acceptance criteria:**
- `TaskAgentManagerConfig` includes **required** `skillsManager` and `appMcpServerRepo` fields (build-time enforcement that callers provide them)
- Both main task agent sessions and sub-sessions pass these through to `AgentSession.fromInit()`
- Sub-sessions also receive `appMcpManager` registry MCPs via `setRuntimeMcpServers()`, matching the main task agent pattern
- `AgentSession.restore()` accepts optional `skillsManager` and `appMcpServerRepo` parameters
- Rehydrated task agent and sub-sessions pass these through via `AgentSession.restore()`
- Existing space tests continue to pass
- New unit tests confirm skills are threaded through for both fresh and rehydrated sessions
- New unit tests confirm sub-sessions receive registry MCPs
- New online test confirms an enabled MCP server skill appears in SDK options for a space task agent

**Dependencies:** None

---

## Task 2: Restore MCP servers and skills for recovered room worker sessions (G5)

**Description:** After daemon restart, room worker sessions (coder/general) recovered by `restoreSession()` lose both user-configured MCP servers (file-based + registry) and skills injection (`skillsManager`/`appMcpServerRepo`). `AgentSession.restore()` does not currently accept these parameters. This task extends the restore path to re-apply both MCP server configs and skills, using the `AgentSession.restore()` signature extension from Task 1.

**Agent type:** coder

**Subtasks:**
1. In `RoomRuntimeService.restoreSession()` (~line 470), after restoring a worker session, pass `skillsManager` and `appMcpServerRepo` through the `AgentSession.restore()` call (using the extended signature from Task 1)
2. Also apply the same file-based + registry MCP server merge logic used in `createSessionFactory()` for coder/general roles
3. Extract the MCP merge logic into a shared helper to avoid duplication between `createSessionFactory()` and the recovery path
4. Add unit tests verifying that a restored coder session has both merged MCP servers and skills injection after recovery
5. Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Acceptance criteria:**
- After daemon restart, recovered coder/general worker sessions have file-based + registry MCP servers applied
- After daemon restart, recovered worker sessions also have `skillsManager` and `appMcpServerRepo` for skills injection
- The MCP merge logic is shared (no copy-paste duplication)
- New unit tests confirm restored worker sessions get both MCP servers and skills
- Existing recovery tests continue to pass

**Dependencies:** Task 1 (requires the `AgentSession.restore()` signature extension)

---

## Task 3: Fix `AppMcpServer.enabled` check in skills-based MCP injection (G6)

**Description:** `QueryOptionsBuilder.getMcpServersFromSkills()` does not check the `AppMcpServer.enabled` flag before injecting servers into SDK options. It only checks `AppSkill.enabled` via `getEnabledSkills()`. If an `AppMcpServer` is disabled but its wrapping `AppSkill` remains enabled, the server is still injected. The fix is straightforward: add an `appServer.enabled` check. Note: normal sessions already receive `skillsManager` and `appMcpServerRepo` through `SessionManager`, and the skills injection path is active at query-build time -- no additional `setRuntimeMcpServers()` call is needed.

**Agent type:** coder

**Subtasks:**
1. Add a check for `appServer.enabled` in `QueryOptionsBuilder.getMcpServersFromSkills()` (~line 839-857) before converting to SDK config -- skip disabled `AppMcpServer` entries even if the wrapping skill is enabled
2. If `getMcpServersFromSkills()` still misses servers after the enabled check fix, investigate whether `skillsManager` is properly wired in the affected session type
3. Add unit tests for `getMcpServersFromSkills()` verifying that disabled `AppMcpServer` entries are filtered out even when the wrapping `AppSkill` is enabled
4. Add an online test confirming a normal session can access a globally-enabled app-level MCP server
5. Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Acceptance criteria:**
- App-level MCP servers appear in normal session SDK options when globally enabled
- Disabled `AppMcpServer` entries are not injected even if the wrapping skill is enabled
- New unit tests cover the `AppMcpServer.enabled` check
- New online test confirms app-level MCP server is accessible in a normal session
- Existing session tests continue to pass

**Dependencies:** None (can run in parallel with Tasks 1 and 2)

---

## Task 4: Fix project-level MCP server disable toggle (G7)

**Description:** The ToolsModal writes disabled server names to `disabledMcpjsonServers` in `.claude/settings.local.json` via `settingsManager.setDisabledMcpServers()`. The SDK reads this key from the settings file. For normal/worker sessions that load `settings.local.json`, this likely works. However, `room_chat` sessions set `settingSources: []`, causing the SDK to skip loading `settings.local.json` entirely -- so `disabledMcpjsonServers` never takes effect. The fix needs to ensure disabled MCP servers are excluded regardless of which settings sources are loaded, likely by passing the disabled list through SDK options directly.

**Agent type:** coder

**Subtasks:**
1. Trace the full path: ToolsModal checkbox → `disabledMcpjsonServers` in `settings.local.json` → SDK settings file loading → MCP server filtering. Confirm which session types are affected (expected: `room_chat` with `settingSources: []`; verify normal/worker sessions work correctly).
2. Identify the right fix: either pass `disabledMcpServers` through SDK options directly (so it doesn't depend on settings file loading), or ensure `room_chat` sessions include `local` in their `settingSources`, or filter disabled servers in `QueryOptionsBuilder.build()` before passing to the SDK.
3. Implement the fix so that MCP servers in the disabled list are excluded from SDK session options for ALL session types, including `room_chat`.
4. Add a unit test for `QueryOptionsBuilder` or the relevant layer that verifies `disabledMcpServers` entries are excluded from the final `mcpServers` map for both normal and room_chat sessions.
5. Add an e2e test targeting a **normal session**: toggle a project-level MCP server off in the ToolsModal, verify it is not listed as available in the session. (Room_chat e2e can be added later if needed.)
6. Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Acceptance criteria:**
- Unchecking a project-level MCP server in ToolsModal prevents it from being loaded in the session (for both normal and room_chat session types)
- Re-checking it makes it available again
- The `disabledMcpServers` config is properly persisted and read
- New unit test confirms disabled servers are excluded for both normal and room_chat session types
- New e2e test targeting a normal session confirms the UI toggle works end-to-end
- Existing ToolsModal and session tests continue to pass

**Dependencies:** None (can run in parallel with other tasks)

---

## Task 5: Redesign Tools UI in session chat container (G8)

**Description:** The current ToolsModal in `packages/web/src/components/ToolsModal.tsx` (573 lines) shows internal implementation details ("Claude Code Preset", "Settings Source" checkboxes) and only displays file-based MCP servers grouped by setting source. App-level MCP servers from the skills registry are not shown at all. The UI needs a full redesign to present all available tools/prompts in logical groups with group-level and individual enable/disable toggles.

**Agent type:** coder

**Subtasks:**
1. **Remove internal concepts from UI:** Remove the "Claude Code Preset" toggle and "Settings Source" (user/project/local) checkboxes from the main UI. These are implementation details that should be managed elsewhere (e.g., advanced settings).
2. **Unified tool/MCP list:** Fetch and display ALL available tools and MCP servers from both sources:
   - File-based MCP servers (from `listMcpServersFromSources()`)
   - App-level MCP servers (from skills registry via `skillsStore`)
3. **Group-based organization:** Organize tools into logical groups (e.g., by category: "File Operations", "Web", "MCP Servers", "Plugins", or by source: "Built-in", "Project", "App-level"). Each group should be collapsible.
4. **Group-level enable/disable:** Add a toggle at the group header level that enables/disables all tools in that group at once.
5. **Individual enable/disable:** Retain individual toggles for each tool/server within a group.
6. **Persist state with clear scoping rules:**
   - **File-based MCP servers** (from settings sources): per-session config via `disabledMcpServers` written to `.claude/settings.local.json` (existing mechanism, fixed by Task 4)
   - **App-level MCP servers** (from skills registry): global enable/disable via `AppSkill.enabled` (affects all sessions), per-room disable via `RoomSkillOverride` (affects room sessions only)
   - **Group-level toggles** should batch-apply the appropriate mechanism for each item in the group (file-based items write to `disabledMcpServers`, app-level items toggle skill enabled state)
   - The UI should clearly indicate scope: "This change affects all sessions" vs "This change affects this session only"
7. **Add unit tests** for new UI components (group toggle logic, unified list rendering, scope-aware persistence).
8. **Add e2e test:** Open the ToolsModal, verify groups are displayed, toggle a group off, verify individual items are disabled, reopen modal and verify state persists.
9. Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Acceptance criteria:**
- "Claude Code Preset" and "Settings Source" no longer shown as top-level sections in the ToolsModal
- All available MCP servers (both file-based and app-level) are displayed in a unified view
- Tools are organized into collapsible groups
- Group-level toggle enables/disables all items in the group using the correct persistence mechanism per item type
- Individual toggles still work independently
- The UI clearly communicates the scope of enable/disable actions (session-local vs global)
- State persists across modal open/close and page refresh
- New unit tests cover group toggle logic and scope-aware persistence
- New e2e test verifies the redesigned UI works end-to-end
- Existing session functionality is not broken

**Dependencies:** Task 3 and Task 4 (the backend must properly handle enable/disable before the UI redesign)

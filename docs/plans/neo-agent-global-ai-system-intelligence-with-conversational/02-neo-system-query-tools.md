# Milestone 2: Neo System Query Tools

## Goal

Implement read-only MCP tools that give Neo full visibility into the HyperNeo system: rooms, spaces, goals, tasks, skills, MCP servers, and app settings.

## Scope

- Create MCP tool handlers following the two-layer pattern from `global-spaces-tools.ts`
- **Reuse existing handlers**: Space-related query tools delegate to the same handler functions used by `global-spaces-tools.ts` rather than reimplementing. Neo wraps them in its own MCP server with Neo-specific formatting.
- Wrap handlers in an MCP server and attach to Neo session
- All tools are read-only (no security tier enforcement needed)

## Tasks

### Task 2.1: Room and Session Query Tools

**Description**: Create MCP tools for querying rooms and sessions.

**Subtasks**:
1. Create `packages/daemon/src/lib/neo/tools/neo-query-tools.ts` with the two-layer pattern:
   - `createNeoQueryToolHandlers(config)` -- testable handler functions
   - `createNeoQueryMcpServer(config)` -- MCP server wrapping handlers
2. Implement `list_rooms` tool: returns all rooms with id, name, status, session count, goal count
3. Implement `get_room_status` tool: returns room details including active sessions, processing state, current model
4. Implement `get_room_details` tool: returns full room info including goals summary, tasks summary, recent messages
5. Implement `get_system_info` tool: returns app version, uptime, auth status, workspace root, active session count
6. Implement `get_app_settings` tool: returns current global settings
7. Define `NeoToolsConfig` interface with all required dependencies (RoomManager, SessionManager, SettingsManager, etc.)
8. Add unit tests for each tool handler

**Acceptance Criteria**:
- All query tools return accurate, well-structured data
- Tools handle edge cases (empty lists, missing rooms) gracefully
- Unit tests cover normal and error paths

**Dependencies**: Task 1.3 (Neo session must exist to attach tools)

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.2: Space and Workflow Query Tools

**Description**: Create MCP tools for querying spaces, workflows, and space tasks.

**Subtasks**:
1. Add to `neo-query-tools.ts`:
   - `list_spaces` tool: returns all spaces with id, name, status, agent count, workflow count
   - `get_space_status` tool: returns space details including active runs, task counts by status
   - `get_space_details` tool: returns full space info including agents, workflows, recent runs
   - `list_space_agents` tool: returns agents for a space
   - `list_space_workflows` tool: returns workflows for a space
   - `list_space_runs` tool: returns workflow runs with status, tasks
2. **Delegate to existing handlers**: Import and reuse the handler functions from `global-spaces-tools.ts` (e.g., `listSpacesHandler`, `getSpaceHandler`, `listWorkflowsHandler`) rather than reimplementing space queries. Neo's MCP tool wrappers call the same handler functions with the same dependencies.
3. Reuse existing `SpaceManager`, `SpaceAgentManager`, `SpaceWorkflowManager` dependencies
4. Add unit tests for each tool handler (can be thin since underlying handlers are already tested)

**Acceptance Criteria**:
- Space query tools return accurate data
- Tools handle missing spaces gracefully with clear error messages
- Unit tests pass

**Dependencies**: Task 2.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.3: Goal and Task Query Tools

**Description**: Create MCP tools for querying goals and tasks across all rooms.

**Subtasks**:
1. Add to `neo-query-tools.ts`:
   - `list_goals` tool: returns goals across all rooms, filterable by room, status, mission type
   - `get_goal_details` tool: returns full goal info including metrics, execution history
   - `get_metrics` tool: returns current metric values for a measurable goal
   - `list_tasks` tool: returns tasks filterable by room, status, assignee
   - `get_task_detail` tool: returns full task info
2. Wire goal queries through `GoalRepository` (cross-room query requires iterating rooms or direct DB access)
3. Wire task queries through `TaskRepository`
4. Add unit tests for each tool handler

**Acceptance Criteria**:
- Cross-room goal/task queries work correctly
- All filters work as documented
- Unit tests pass

**Dependencies**: Task 2.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.4: Skill and MCP Server Query Tools

**Description**: Create MCP tools for querying skills and MCP servers.

**Subtasks**:
1. Add to `neo-query-tools.ts`:
   - `list_mcp_servers` tool: returns all registered MCP servers with enabled/disabled status
   - `get_mcp_server_status` tool: returns MCP server details (type, config, connected rooms)
   - `list_skills` tool: returns all skills with type, enabled status
   - `get_skill_details` tool: returns full skill info including validation status
2. Wire MCP queries through `AppMcpServerRepository`
3. Wire skill queries through `SkillsManager`
4. Add unit tests for each tool handler

**Acceptance Criteria**:
- MCP and skill queries return accurate status
- Tools handle missing entities gracefully
- Unit tests pass

**Dependencies**: Task 2.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.5: Attach Query Tools MCP Server to Neo Session

**Description**: Wire the query tools MCP server into Neo's provisioning flow.

**Subtasks**:
1. Update `NeoAgentManager.provision()` to create the query tools MCP server
2. Pass all required dependencies (`NeoToolsConfig`) from `createDaemonApp` context
3. Attach MCP server to Neo session via `setRuntimeMcpServers()` (same as spaces agent)
4. Merge registry-sourced MCP servers (AppMcpLifecycleManager) with Neo's in-process tools
5. Add integration test verifying Neo can use query tools (mock SDK, verify tool calls)

**Acceptance Criteria**:
- Neo session has all query tools available
- Registry MCP servers are merged without conflicts
- Neo's in-process tools take precedence on name collision
- Integration test passes

**Dependencies**: Tasks 2.1, 2.2, 2.3, 2.4

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

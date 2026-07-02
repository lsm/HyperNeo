# Milestone 2: Custom Agent Data & Runtime

## Goal

Define custom agent types, repository, manager, RPC handlers, and runtime integration so that user-defined agents can execute tasks within Spaces alongside built-in agents.

## Key Design Decision: AgentType Preservation

**`AgentType` is NOT widened to `string`.** The existing `AgentType = 'coder' | 'general'` union remains unchanged. Custom agents are referenced exclusively via the `customAgentId?: string` field on `SpaceTask`. Resolution logic:
- If `task.customAgentId` is set → resolve `SpaceAgent` from `SpaceAgentManager` and use `createCustomAgentInit()`
- If `task.customAgentId` is not set → use existing `assignedAgent` (`AgentType`) resolution

## Scope

- Custom agent types in `packages/shared/src/types/space.ts`
- `SpaceAgentRepository` and `SpaceAgentManager`
- RPC handlers for agent CRUD
- `createCustomAgentInit()` factory function
- Task assignment integration for custom agents
- Unit tests

---

### Task 2.1: Custom Agent Types, Repository, and Manager

**Agent:** coder
**Priority:** high
**Depends on:** Task 1.2

**Description:**

Define the custom agent types and build the data access + business logic layers for managing agents within a Space. The `space_agents` table was already created in the M1 migration.

**Subtasks:**

1. Add agent types to `packages/shared/src/types/space.ts`:
   ```typescript
   /** A user-defined agent within a Space */
   interface SpaceAgent {
     id: string;
     spaceId: string;
     name: string;
     description: string;
     model: string;
     provider?: string;
     tools: string[];
     systemPrompt: string;
     role: 'worker' | 'reviewer' | 'orchestrator';
     config?: Record<string, unknown>;
     createdAt: number;
     updatedAt: number;
   }

   interface CreateSpaceAgentParams {
     name: string;
     description?: string;
     model: string;
     provider?: string;
     tools: string[];
     systemPrompt?: string;
     role?: 'worker' | 'reviewer' | 'orchestrator';
     config?: Record<string, unknown>;
   }

   interface UpdateSpaceAgentParams {
     name?: string;
     description?: string;
     model?: string;
     provider?: string;
     tools?: string[];
     systemPrompt?: string;
     role?: 'worker' | 'reviewer' | 'orchestrator';
     config?: Record<string, unknown>;
   }
   ```

2. **Define `KNOWN_TOOLS` constant** in `packages/shared/src/types/tools.ts` (new file):
   - `export const KNOWN_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'TaskOutput', 'TaskStop'] as const;`
   - `export type KnownTool = (typeof KNOWN_TOOLS)[number];`
   - Single source of truth for tool names, used by manager validation and frontend tool picker
   - Export from shared package barrel

3. Create `packages/daemon/src/storage/repositories/space-agent-repository.ts`:
   - `createAgent(params: CreateSpaceAgentParams & { spaceId: string }): SpaceAgent`
   - `getAgent(id: string): SpaceAgent | null`
   - `listAgents(spaceId: string): SpaceAgent[]`
   - `updateAgent(id: string, params: UpdateSpaceAgentParams): SpaceAgent | null`
   - `deleteAgent(id: string): boolean`
   - `getAgentsByIds(ids: string[]): SpaceAgent[]` — batch lookup for workflow validation
   - `isAgentReferenced(agentId: string): { workflows: string[] }` — checks if agent is referenced by workflow steps (`space_workflow_steps.agent_id = agentId`)
   - Handle JSON serialization for `tools` and `config`

4. Create `packages/daemon/src/lib/space/managers/space-agent-manager.ts`:
   - Wraps repository with validation:
     - `name` unique within space
     - `tools` contains only known tool names (reference `KNOWN_TOOLS`)
     - `model` is a recognized model ID (use models list from `@hyperneo/shared`)
   - **Deletion protection**: If agent is referenced by workflow steps, return error with list of referencing workflow names

5. Write unit tests for repository and manager:
   - CRUD operations
   - Unique name constraint, tool validation, model validation
   - JSON round-trip for tools and config
   - Deletion protection when referenced by workflows

**Acceptance criteria:**
- Types are defined and exported from `@hyperneo/shared`
- `KNOWN_TOOLS` constant is the single source of truth for tool names
- Repository handles all CRUD with JSON serialization
- Manager validates uniqueness, tools, and models
- Deletion is blocked when agent is referenced by workflow steps
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 2.2: Custom Agent RPC Handlers

**Agent:** coder
**Priority:** high
**Depends on:** Task 2.1

**Description:**

Add RPC handlers and DaemonEventMap entries for custom agent CRUD within Spaces.

**Subtasks:**

1. Register in `DaemonEventMap`:
   ```typescript
   'spaceAgent.created': { sessionId: string; spaceId: string; agent: SpaceAgent };
   'spaceAgent.updated': { sessionId: string; spaceId: string; agent: SpaceAgent };
   'spaceAgent.deleted': { sessionId: string; spaceId: string; agentId: string };
   ```

2. Create `packages/daemon/src/lib/rpc-handlers/space-agent-handlers.ts`:
   - `spaceAgent.create { spaceId, name, description, model, provider, tools, systemPrompt, role }` → `{ agent }`
   - `spaceAgent.list { spaceId }` → `{ agents }`
   - `spaceAgent.get { id }` → `{ agent }`
   - `spaceAgent.update { id, ... }` → `{ agent }`
   - `spaceAgent.delete { id }` → `{ success }` (error if referenced by workflows)

3. Wire handlers in `packages/daemon/src/lib/rpc-handlers/index.ts` (via `setupRPCHandlers()` — add new registration, don't modify existing)

4. Emit DaemonHub events for create/update/delete

5. Write unit tests for each handler including error cases

**Acceptance criteria:**
- All CRUD operations work via RPC
- DaemonHub events are registered and emitted
- Delete returns clear error when agent is referenced by workflows
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 2.3: Custom Agent Session Init Factory and Task Integration

**Agent:** coder
**Priority:** high
**Depends on:** Task 2.1

**Description:**

Create the factory function that builds an `AgentSessionInit` from a `SpaceAgent` definition, and wire custom agent resolution into the task assignment flow.

**Subtasks:**

1. Create `packages/daemon/src/lib/space/agents/custom-agent.ts`:
   - `CustomAgentConfig` interface: `{ customAgent: SpaceAgent, task: SpaceTask, workflowRun: SpaceWorkflowRun | null, space: Space, sessionId: string, workspacePath: string, previousTaskSummaries?: string[] }`
   - `buildCustomAgentSystemPrompt(customAgent: SpaceAgent): string` — uses custom `systemPrompt` as base, prepends role identification and mandatory git workflow instructions, appends bypass markers and review feedback sections
   - `buildCustomAgentTaskMessage(config: CustomAgentConfig): string` — builds initial task message with task/workflow/space context
   - `createCustomAgentInit(config: CustomAgentConfig): AgentSessionInit` — builds session init with agent's tools, model, and custom prompt

2. Handle roles:
   - `worker`: use `claude_code` preset with custom prompt, standard tools from `customAgent.tools`
   - `reviewer`: same as worker but prompt includes review-specific instructions (structured feedback format). **Important**: reviewers are specialized Workers, NOT Leader replacements.
   - `orchestrator`: reserved for future, treat same as worker

3. Create a resolution helper for SpaceRuntime (to be used in M4):
   - `resolveAgentInit(task: SpaceTask, space: Space, agentManager: SpaceAgentManager): AgentSessionInit` — if `customAgentId` set, resolve from agent manager and use `createCustomAgentInit()`; otherwise, use built-in agent factories
   - This helper centralizes the "custom vs built-in" resolution logic

4. Write unit tests:
   - `AgentSessionInit` correctly built for each role
   - System prompt includes git workflow instructions
   - Tool list propagated from `SpaceAgent`
   - Model/provider from `SpaceAgent` used
   - Resolution helper picks custom vs built-in correctly
   - Reviewer role includes review-specific prompt additions

**Acceptance criteria:**
- `createCustomAgentInit()` produces valid session init for custom agents
- System prompt includes both custom content and mandatory infrastructure
- Tool list configurable via `SpaceAgent.tools`
- Resolution helper provides clean custom-vs-builtin switching
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

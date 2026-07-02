# Milestone 3: Workflow Data Model

## Goal

Define the workflow types, repository, manager, RPC handlers, and built-in templates for custom workflows within Spaces. A workflow defines a directed graph of agent steps connected by transitions with optional conditions and configurable rules. All code lives in the Space namespace — no existing Room code is modified.

## Isolation Checklist

- Types in `packages/shared/src/types/space.ts` (NOT `neo.ts`)
- Repository in `packages/daemon/src/storage/repositories/space-workflow-repository.ts`
- Manager in `packages/daemon/src/lib/space/managers/space-workflow-manager.ts`
- RPC handlers use `spaceWorkflow.*` namespace (NOT `workflow.*`)
- DaemonEventMap entries use `spaceWorkflow.*` namespace
- Built-in templates in `packages/daemon/src/lib/space/workflows/built-in-workflows.ts`
- Exports from `packages/daemon/src/lib/space/index.ts` (NOT `room/index.ts`)
- DB tables `space_workflows` and `space_workflow_steps` already created in M1 migration — **no new migration needed**

## Scope

- Workflow shared types (transitions, conditions, steps, rules) in `space.ts`
- `SpaceWorkflowRepository` and `SpaceWorkflowManager`
- RPC handlers for workflow CRUD (`spaceWorkflow.*`)
- DaemonEventMap registration (`spaceWorkflow.created/updated/deleted`)
- Built-in workflow templates
- Unit tests

---

### Task 3.1: Define Workflow Shared Types

**Agent:** coder
**Priority:** high
**Depends on:** (none — types are independent)

**Description:**

Add workflow types to `packages/shared/src/types/space.ts` (alongside the Space/SpaceTask/SpaceWorkflowRun types from M1 and SpaceAgent types from M2).

**Subtasks:**

1. Add the following types to `packages/shared/src/types/space.ts`:

   ```typescript
   /** Condition type for a workflow transition */
   type WorkflowConditionType = 'always' | 'human' | 'condition';

   /**
    * A condition that guards a workflow transition.
    * Conditions determine whether a transition may fire when advance() is called.
    */
   interface WorkflowCondition {
     type: WorkflowConditionType;
     /**
      * Shell expression to evaluate for the `condition` type.
      * The transition fires when the expression exits with code 0.
      */
     expression?: string;
     description?: string;
     /** Max retries on failure (0 = no retry). Retry re-evaluates condition only, NOT re-run agent. */
     maxRetries?: number;
     /** Timeout for condition evaluation in ms (0 = use default 60000ms, max 300000ms) */
     timeoutMs?: number;
   }

   /**
    * A directed edge in the workflow graph.
    * Transitions connect steps and carry optional conditions.
    */
   interface WorkflowTransition {
     id: string;
     from: string;
     to: string;
     condition?: WorkflowCondition;
     /** Sort order among transitions with the same `from` step. Lower = evaluated first. */
     order?: number;
   }

   /** A single step in a workflow */
   interface WorkflowStep {
     id: string;
     name: string;
     /**
      * ID of the SpaceAgent assigned to execute this step.
      * Preset agents (coder, general, planner, reviewer) are seeded at Space creation time
      * as regular SpaceAgent records with well-known role labels.
      */
     agentId: string;
     instructions?: string;
   }

   /** Rule injected into agent prompts */
   interface WorkflowRule {
     id: string;
     name: string;
     content: string;
     /**
      * Which steps this rule applies to, by step **ID** (not name).
      * IDs survive step renames. Empty array = applies to all steps.
      */
     appliesTo?: string[];
   }

   /** A complete workflow definition within a Space */
   interface SpaceWorkflow {
     id: string;
     spaceId: string;
     name: string;
     description: string;
     steps: WorkflowStep[];
     transitions: WorkflowTransition[];
     rules: WorkflowRule[];
     /**
      * @deprecated Not used for workflow selection. Workflow selection uses only
      * explicit workflowId or AI auto-select. Retained for backward compatibility.
      */
     isDefault: boolean;
     /** Organizational tags. Not used for automatic workflow selection. */
     tags: string[];
     config?: Record<string, unknown>;
     createdAt: number;
     updatedAt: number;
   }

   interface CreateSpaceWorkflowParams {
     name: string;
     description?: string;
     steps: Omit<WorkflowStep, 'id'>[];
     transitions?: Omit<WorkflowTransition, 'id'>[];
     rules?: Omit<WorkflowRule, 'id'>[];
     /** Organizational tags (not used for automatic selection). */
     tags?: string[];
     config?: Record<string, unknown>;
   }

   interface UpdateSpaceWorkflowParams {
     name?: string;
     description?: string;
     steps?: Omit<WorkflowStep, 'id'>[];
     transitions?: Omit<WorkflowTransition, 'id'>[] | null;
     rules?: Omit<WorkflowRule, 'id'>[] | null;
     /** Replaces the tag list. Pass `[]` or `null` to clear. Organizational only. */
     tags?: string[] | null;
     config?: Record<string, unknown>;
   }
   ```

2. Export all types from shared package barrel (`packages/shared/src/mod.ts`)

**Acceptance criteria:**
- All workflow types defined and exported from `@hyperneo/shared` via `space.ts`
- JSDoc on all interfaces with clear semantics for `maxRetries`, `expression` (for `condition` type), and `agentId` (SpaceAgent UUID)
- `agentId` must reference an existing `SpaceAgent` in the same space; preset roles (`planner`, `coder`, `general`, `reviewer`) are regular `SpaceAgent` records
- No modifications to `packages/shared/src/types/neo.ts`
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3.2: SpaceWorkflowRepository and SpaceWorkflowManager

**Agent:** coder
**Priority:** high
**Depends on:** Task 3.1, Task 1.2

**Description:**

Build the data access and business logic layers for workflows within Spaces. The `space_workflows` and `space_workflow_steps` tables were already created in the M1 migration — **no new migration needed**.

**Subtasks:**

1. Create `packages/daemon/src/storage/repositories/space-workflow-repository.ts`:
   - `createWorkflow(params: CreateSpaceWorkflowParams & { spaceId: string }): SpaceWorkflow`
   - `getWorkflow(id: string): SpaceWorkflow | null` — joins with `space_workflow_steps`
   - `listWorkflows(spaceId: string): SpaceWorkflow[]`
   - `updateWorkflow(id: string, params: UpdateSpaceWorkflowParams): SpaceWorkflow | null`
   - `deleteWorkflow(id: string): boolean`
   - `getWorkflowsReferencingAgent(agentId: string): SpaceWorkflow[]` — finds workflows referencing a custom agent (used for deletion protection in `SpaceAgentManager`)
   - Handle step CRUD within workflow transactions (replace all steps on update)
   - JSON serialization for `rules` and `transitions`
   - `rowToWorkflow()` and `rowToStep()` mapping functions
   - **No `getDefaultWorkflow`/`setDefaultWorkflow`** — workflow selection uses only explicit workflowId or AI auto-select.

2. Create `packages/daemon/src/lib/space/managers/space-workflow-manager.ts`:
   - Validation:
     - Name unique within space
     - Each step's `agentId` must reference an existing `SpaceAgent` in the same space
     - At least one step required
     - All transition `from`/`to` values must reference step IDs that exist in the workflow
     - Condition validation: `condition` type requires non-empty `expression`; `timeoutMs` within range 0–300000
   - Business logic: workflow selection is either explicit workflowId (caller-provided) or AI auto-select via `list_workflows` + `start_workflow_run`. No default workflow concept, no `isDefault` flag.

3. Export from `packages/daemon/src/lib/space/index.ts`

4. Write unit tests:
   - Full CRUD lifecycle
   - Step and transition validation (agentId references valid SpaceAgent, transition from/to reference valid step IDs)
   - Rejection of unknown `agentId` values (SpaceAgent must exist in same space)
   - Condition validation (expression required, timeoutMs range)
   - JSON round-trip for transitions and rules
   - `getWorkflowsReferencingAgent` returns correct results

**Acceptance criteria:**
- Repository handles CRUD with proper step management using `space_workflows`/`space_workflow_steps` tables
- Manager validates workflow integrity including transition/condition validation
- Agent reference validation queries `SpaceAgentManager` (NOT a nonexistent `CustomAgentManager`)
- No `isDefault` flag on `SpaceWorkflow` — workflow selection is explicit workflowId or AI auto-select only
- All files in Space namespace — nothing in `packages/daemon/src/lib/room/`
- Unit tests cover all paths
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3.3: Workflow RPC Handlers and DaemonEventMap Registration

**Agent:** coder
**Priority:** high
**Depends on:** Task 3.2

**Description:**

Add RPC handlers for workflow CRUD using the `spaceWorkflow.*` namespace. Register events in DaemonEventMap.

**Subtasks:**

1. Register in `DaemonEventMap` (`packages/daemon/src/lib/daemon-hub.ts`):
   ```typescript
   'spaceWorkflow.created': { sessionId: string; spaceId: string; workflow: SpaceWorkflow };
   'spaceWorkflow.updated': { sessionId: string; spaceId: string; workflow: SpaceWorkflow };
   'spaceWorkflow.deleted': { sessionId: string; spaceId: string; workflowId: string };
   ```
   Import `SpaceWorkflow` from `@hyperneo/shared`.

2. Create `packages/daemon/src/lib/rpc-handlers/space-workflow-handlers.ts`:
   - `spaceWorkflow.create { spaceId, name, description, steps, rules }` → `{ workflow }`
   - `spaceWorkflow.list { spaceId }` → `{ workflows }`
   - `spaceWorkflow.get { id }` → `{ workflow }`
   - `spaceWorkflow.update { id, ... }` → `{ workflow }`
   - `spaceWorkflow.delete { id }` → `{ success }`
   - **No `spaceWorkflow.setDefault`** — there is no default workflow concept

3. Wire handlers in `packages/daemon/src/lib/rpc-handlers/index.ts` (via `setupRPCHandlers()` — add new registration only, do not modify existing handler setup)

4. Emit DaemonHub events: `spaceWorkflow.created`, `spaceWorkflow.updated`, `spaceWorkflow.deleted`

5. Write unit tests for all handlers

**Acceptance criteria:**
- All CRUD operations work via `spaceWorkflow.*` RPC namespace
- DaemonHub events use `spaceWorkflow.*` namespace (matching what `SpaceStore` subscribes to in M5)
- Error handling covers not-found, validation failures
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3.4: Built-in Workflow Templates

**Agent:** coder
**Priority:** normal
**Depends on:** Task 3.2

**Description:**

Create built-in workflow templates that serve as examples. All files in Space namespace.

**Subtasks:**

1. Create `packages/daemon/src/lib/space/workflows/built-in-workflows.ts`:
   - `CODING_WORKFLOW`: Planner → Coder (with `human` condition on Planner→Coder transition) — mirrors current multi-agent behavior. Leader is implicit per group, not a step.
   - `RESEARCH_WORKFLOW`: Planner → General (with `always` conditions)
   - `REVIEW_ONLY_WORKFLOW`: Coder (single terminal step, no outgoing transitions)

2. Each template includes appropriate transition conditions

3. `getBuiltInWorkflows(): SpaceWorkflow[]` — returns templates without space-specific IDs (no `isDefault` flag, no seeding logic)

4. Write unit tests:
   - Template structure validation
   - All agent refs are valid builtins (no 'leader')

**Acceptance criteria:**
- Three built-in workflow templates defined
- Templates mirror existing behavior (Leader is implicit, not a step)
- No `seedDefaultWorkflow` — there is no default workflow concept; users pick or the Space agent auto-selects via AI
- All files in `packages/daemon/src/lib/space/workflows/` (NOT `room/workflows/`)
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

# Plan: End Node Completion + Schema Cleanup

## Goal

The workflow graph currently has `startNodeId` but no `endNodeId`. Workflow completion relies on the Task Agent LLM calling `report_workflow_done`, which is fragile and architecturally incorrect — task completion is a workflow concern, not a task concern.

In addition, the current schema has accumulated dead fields, leaked workflow-internal columns on `space_tasks`, and a missing first-class `node_executions` table. This plan combines the `endNodeId` feature with a schema cleanup to produce a clean, well-separated data model.

## Approach

1. **Clean schema design**: Separate workflow-internal state (`node_executions`) from user-facing tasks (`space_tasks`). Remove dead/deprecated columns from all tables.
2. **`endNodeId` on `SpaceWorkflow`**: When the end node's execution calls `report_done`, `CompletionDetector` auto-completes the workflow run.
3. **Remove `report_workflow_done`**: The Task Agent focuses on spawning/monitoring/gates; the runtime handles completion.

## New Schema Design

### `space_tasks` — Cleaned Up

| Field | Type | Description |
|---|---|---|
| `id` | `string` (UUID) | Primary key |
| `spaceId` | `string` (UUID) | Scope |
| `taskNumber` | `number` | Auto-incremented per space, human-friendly ID |
| `title` | `string` | Displayed everywhere |
| `description` | `string \| null` | Detail view |
| `status` | `SpaceTaskStatus` | `open` `in_progress` `done` `blocked` `cancelled` `archived` |
| `priority` | `0 \| 1 \| 2 \| 3` | P0–P3, default `2` |
| `labels` | `string[]` | Filtering, categorisation |
| `dependsOn` | `string[]` | Task IDs in same space (prerequisites) |
| `result` | `string \| null` | Final output from agent |
| `createdAt` | `number` | Unix ms, immutable |
| `startedAt` | `number \| null` | Stamped on `in_progress` |
| `completedAt` | `number \| null` | Stamped on `done` / `cancelled` |
| `updatedAt` | `number` | Every write |
| `archivedAt` | `number \| null` | Stamped on `archived` |

**Kept but not shown in table above (existing fields, unchanged):** `workflowRunId` (links orchestration task to its run — needed by `cancel_workflow_run`), `taskAgentSessionId` (orchestration task's Task Agent session ID — needed for activity panel display and session rehydration after daemon restart; node-level tasks no longer use this field, they use `node_executions.agentSessionId` instead), `prUrl`, `prNumber`, `prCreatedAt` (PR tracking — user-facing), `activeSession` (current working session), `createdByTaskId` (task lineage).

**Removed from `space_tasks`:** `workflowNodeId`, `agentName`, `customAgentId`, `taskType`, `goalId`, `error`, `assignedAgent`, `inputDraft` (UI draft state — no longer stored server-side), `progress` (workflow-internal — moves to `NodeExecution`), `currentStep` (workflow-internal — moves to `NodeExecution`), `completionSummary` (workflow-internal — moves to `NodeExecution.result`), `draft`/`pending`/`review`/`needs_attention`/`rate_limited`/`usage_limited` statuses.

**Status changes:** Old `SpaceTaskStatus` had 10 values: `draft`, `pending`, `in_progress`, `review`, `completed`, `needs_attention`, `cancelled`, `archived`, `rate_limited`, `usage_limited`. New `SpaceTaskStatus` has 6 values: `open`, `in_progress`, `done`, `blocked`, `cancelled`, `archived`. Mapping: `draft`/`pending` → `open`, `completed` → `done`, `review`/`needs_attention`/`rate_limited`/`usage_limited` → no equivalent (workflow-internal concerns move to `node_executions`).

### `node_executions` — New Table

| Field | Type | Description |
|---|---|---|
| `id` | `string` (UUID) | Primary key |
| `workflowRunId` | `string` (UUID) | Links to `space_workflow_runs` |
| `workflowNodeId` | `string` | Which node in workflow definition |
| `agentName` | `string` | Channel routing address |
| `agentId` | `string` | Which agent runs this slot |
| `agentSessionId` | `string \| null` | Agent sub-session ID for liveness |
| `status` | `NodeExecutionStatus` | `pending` `in_progress` `done` `blocked` `cancelled` |
| `result` | `string \| null` | Output from `report_done(summary)` |
| `createdAt` | `number` | Unix ms |
| `startedAt` | `number \| null` | Stamped on `in_progress` |
| `completedAt` | `number \| null` | Stamped on terminal |
| `updatedAt` | `number` | Every write |

### `space_workflows` — Cleaned Up

Added: `endNodeId`. Removed: `rules`, `config`, `maxIterations`, `isDefault`.

### `space_workflow_runs` — Cleaned Up

Status values: `pending` `in_progress` `done` `blocked` `cancelled`. Kept: `failureReason` (gate rejection state discriminator). Removed: `config`, `goalId`, `iterationCount`, `maxIterations`.

### `workflow_nodes` — Cleaned Up

Removed: `agentId` shorthand (always use `agents[]`), `model`/`systemPrompt` overrides on node, `orderIndex`, `config` blob.

### `space_agents` — Cleaned Up

Added: `instructions: string | null` (default operating procedure — separate from `systemPrompt` which is persona/constraints). Removed: `role`, `toolConfig`, `injectWorkflowContext`.

### Two-Layer Override Design for `systemPrompt` and `instructions`

**Design decision:** Remove the three-level `WorkflowNode → WorkflowNodeAgent → SpaceAgent` override chain. Use two levels only:

| Level | `systemPrompt` | `instructions` |
|---|---|---|
| `SpaceAgent` | ✅ who the agent is (persona, constraints) | ✅ what the agent does by default (operating procedure) |
| `WorkflowNodeAgent` | ✅ optional slot override with explicit mode | ✅ optional slot override with explicit mode |
| `WorkflowNode` | ❌ removed (was artifact of `agentId` shorthand) | ❌ removed (was artifact of `agentId` shorthand) |

**`WorkflowNodeAgent` override shape** — both fields use an explicit mode object:

```typescript
systemPrompt?: {
  mode: 'override' | 'expand'   // expand = append after agent's systemPrompt
  value: string
}
instructions?: {
  mode: 'override' | 'expand'   // expand = append after agent's instructions
  value: string
}
```

Default mode is `'override'` (full control). `'expand'` appends after the agent's base value with `"\n\n"` separator.

**Runtime composition:**
```
Final systemPrompt:
  slot.systemPrompt.mode == 'override' → slot.systemPrompt.value
  slot.systemPrompt.mode == 'expand'   → agent.systemPrompt + "\n\n" + slot.systemPrompt.value
  slot.systemPrompt absent             → agent.systemPrompt

Final instructions: same logic
```

This replaces the old `resolveNodeAgents()` spreading behavior where `WorkflowNode.systemPrompt` overrode all slot-level prompts.

---

## Task 1: Schema type definitions

**Description:** Update all shared type definitions in `packages/shared/src/types/space.ts` and `packages/shared/src/types/space-utils.ts` to reflect the new schema design. This is the foundational task — all other tasks depend on it.

**Agent type:** coder

**Subtasks:**

1. **`SpaceTaskStatus` and `SpaceTask`:**
   - Change `SpaceTaskStatus` from `'draft' | 'pending' | 'in_progress' | 'review' | 'completed' | 'needs_attention' | 'cancelled' | 'archived' | 'rate_limited' | 'usage_limited'` to `'open' | 'in_progress' | 'done' | 'blocked' | 'cancelled' | 'archived'`.
   - Update `SpaceTask` interface:
     - **Remove:** `workflowNodeId`, `agentName`, `customAgentId`, `taskType`, `goalId`, `error`, `assignedAgent`, `inputDraft`, `progress`, `currentStep`, `completionSummary`.
     - **Add:** `taskNumber: number`, `labels: string[]`, `dependsOn: string[]`, `result: string | null`, `startedAt: number | null`, `completedAt: number | null`, `archivedAt: number | null`.
     - **Keep:** `id`, `spaceId`, `title`, `description`, `status`, `priority`, `createdAt`, `updatedAt`, `workflowRunId` (orchestration task linkage), `taskAgentSessionId` (orchestration task's Task Agent session — needed for activity panel and rehydration; node-level tasks use `node_executions.agentSessionId` instead), `prUrl`, `prNumber`, `prCreatedAt` (PR tracking), `activeSession`, `createdByTaskId`.
   - Update `CreateSpaceTaskParams` and `UpdateSpaceTaskParams` accordingly.

2. **`NodeExecution` type (new):**
   - Add `NodeExecutionStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'cancelled'`.
   - Add `NodeExecution` interface with all fields from the schema table above.
   - Add `CreateNodeExecutionParams` and `UpdateNodeExecutionParams`.

3. **`SpaceWorkflow`:**
   - Add `endNodeId?: string` to `SpaceWorkflow` with JSDoc.
   - Add `endNodeId?: string` to `CreateSpaceWorkflowParams`.
   - Add `endNodeId?: string | null` to `UpdateSpaceWorkflowParams`.
   - Remove `rules`, `config`, `maxIterations`, `isDefault` from all three interfaces.
   - Add `endNode?: string` to `ExportedSpaceWorkflow` (optional, unlike required `startNode`).

4. **`SpaceWorkflowRun`:**
   - Change `WorkflowRunStatus` to `'pending' | 'in_progress' | 'done' | 'blocked' | 'cancelled'`.
   - Remove `config`, `goalId`, `iterationCount`, `maxIterations` from `SpaceWorkflowRun` and its create/update params. **Keep `failureReason`** — it is the gate rejection state discriminator.
   - Add `startedAt: number | null` (does not currently exist on this type). Keep `completedAt: number | null` (already present).

5. **`WorkflowNode`:**
   - Remove `agentId` shorthand field — always use `agents: WorkflowNodeAgent[]`.
   - Remove `model`, `systemPrompt`, `orderIndex`, `config` from `WorkflowNode`. Note: `model` and `systemPrompt` are persisted inside the `config` JSON blob in `space_workflow_nodes`, not as top-level DB columns. They are being removed from the TypeScript interface and from the JSON blob serialization/deserialization.
   - Keep `id`, `name`, `agents`, `instructions`.
   - `resolveNodeAgents()` in `space-utils.ts` will need a compat shim for legacy `agentId` data — see Task 7.2 for implementation details.

6. **`SpaceAgent`:**
   - Remove `role`, `toolConfig`, `injectWorkflowContext` from `SpaceAgent` interface.
   - Add `instructions: string | null` — the agent's default operating procedure (injected into the initial task message alongside `systemPrompt`).
   - Keep `id`, `spaceId`, `name`, `description`, `model`, `provider`, `systemPrompt`, `tools`, `createdAt`, `updatedAt`.
   - Update `CreateSpaceAgentParams` and `UpdateSpaceAgentParams` to include `instructions`.

7. **`WorkflowNodeAgent` override shape:**
   - Change `systemPrompt?: string` to `systemPrompt?: { mode: 'override' | 'expand'; value: string }`.
   - Change `instructions?: string` to `instructions?: { mode: 'override' | 'expand'; value: string }`.
   - This replaces the old three-level `WorkflowNode.systemPrompt → WorkflowNodeAgent.systemPrompt → SpaceAgent.systemPrompt` chain with a clean two-level design.
   - Old `WorkflowNode.systemPrompt` and `WorkflowNode.instructions` are removed from `WorkflowNode` type (they were artifacts of the `agentId` shorthand, not intentional design).

8. **`SpaceTaskActivityMember` type update:**
   - `SpaceTaskActivityMember` (in `packages/shared/src/types/space.ts`, lines 246–285) references `workflowNodeId`, `agentName`, `currentStep`, `error`, `completionSummary`, and old `SpaceTaskStatus` values.
   - Remove `workflowNodeId`, `agentName`, `currentStep`, `error`, `completionSummary` fields (these move to `NodeExecution` or are dropped entirely).
   - Update `taskStatus` field to use the new `SpaceTaskStatus` union (6 values).
   - If the activity view needs node execution context, add an optional `nodeExecution?: { nodeId: string, agentName: string, status: NodeExecutionStatus }` sub-object, populated via JOIN in live queries.

9. **`ExportedWorkflowNodeAgent` type update:**
   - Change `systemPrompt?: string` to `systemPrompt?: { mode: 'override' | 'expand'; value: string }`.
   - Change `instructions?: string` to `instructions?: { mode: 'override' | 'expand'; value: string }`.
   - This ensures export serialization matches the in-memory type. Without this update, `ExportedWorkflowNodeAgent.systemPrompt` would be typed as `string` but receive a `{ mode, value }` object at runtime, causing silent type mismatches on import.

10. **`ExportedWorkflowNode` cleanup:**
   - Remove `systemPrompt?: string` — `WorkflowNode.systemPrompt` is removed (Task 1.5), so the export type must not reference it.
   - Remove `instructions?: string` — `WorkflowNode.instructions` is removed. Node-level instructions are now per-agent slot only (via `ExportedWorkflowNodeAgent.instructions`).
   - Remove `model?: string` — same reasoning (node-level model override removed).

11. **`ExportedSpaceWorkflow` cleanup:**
   - Add `endNode?: string` to `ExportedSpaceWorkflow`.
   - Remove `rules: ExportedWorkflowRule[]` from `ExportedSpaceWorkflow` and remove the `ExportedWorkflowRule` type if it becomes unused.
   - This ensures Task 9 (export/import) can reference the updated type without a hidden dependency.

12. **`ExportedSpaceAgent` type update:**
   - Add `instructions?: string` to `ExportedSpaceAgent` (nullable string, matching `SpaceAgent.instructions`).
   - Remove `role` from `ExportedSpaceAgent` (role is being removed from `SpaceAgent`).

13. **Update `TERMINAL_TASK_STATUSES`** (in `completion-detector.ts` or shared types): update to match new `NodeExecutionStatus` terminal values: `done`, `cancelled`. The old set (`completed`, `needs_attention`, `cancelled`, `rate_limited`, `usage_limited`) is replaced.

**Acceptance criteria:**
- `bun run typecheck` passes (expect many downstream errors initially — this task focuses on type definitions only; downstream fixes are in later tasks).
- All new types are exported from `@hyperneo/shared`.
- Old status values and removed fields are no longer in the type definitions.

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 2: DB migrations

**Description:** Create SQLite migrations to transform all tables to the new schema. This is a large migration task covering multiple tables. SQLite requires table recreation for column removal (cannot `ALTER TABLE DROP COLUMN` in all cases). Use the existing recreation pattern from migrations 51, 55, 60, 62.

**Agent type:** coder

**Subtasks:**

1. **`space_tasks` migration:**
   - Recreate `space_tasks` table with the new column set. Drop: `workflow_node_id`, `agent_name`, `custom_agent_id`, `task_type`, `goal_id`, `error`, `assigned_agent`, `input_draft`, `progress`, `current_step`, `completion_summary`. Keep: `workflow_run_id` (orchestration task linkage), `task_agent_session_id` (orchestration task's Task Agent session — needed for activity panel and rehydration after restart), `pr_url`, `pr_number`, `pr_created_at`, `active_session`, `created_by_task_id`. Add: `task_number` (INTEGER, auto-increment per space), `labels` (TEXT, JSON array default `'[]'`), `depends_on` (TEXT, JSON array default `'[]'`), `result` (TEXT nullable), `started_at` (INTEGER nullable), `completed_at` (INTEGER nullable), `archived_at` (INTEGER nullable).
   - **`task_number` NULL handling:** If any legacy rows have null `task_number`, use `COALESCE(task_number, ROW_NUMBER() OVER (PARTITION BY space_id ORDER BY created_at))` in the `INSERT INTO ... SELECT` to guarantee non-null values.
   - **Status migration:** Map old values: `draft` → `open`, `pending` → `open`, `completed` → `done`, `review` → `in_progress` (tasks in `review` at migration time are treated as still in-progress work — the `review` concept moves to `node_executions`), `needs_attention` → `blocked`, `rate_limited` → `blocked`, `usage_limited` → `blocked`. Keep `in_progress`, `cancelled`, `archived` as-is.
   - Update CHECK constraint on `status` column to new values.
   - Copy existing data with status mapping during table recreation.

2. **`node_executions` table (new):**
   - `CREATE TABLE node_executions (id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, workflow_node_id TEXT NOT NULL, agent_name TEXT NOT NULL, agent_id TEXT NOT NULL, agent_session_id TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','done','blocked','cancelled')), result TEXT, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, updated_at INTEGER NOT NULL)`.
   - Add indexes: `idx_node_executions_run` on `workflow_run_id`, `idx_node_executions_node` on `(workflow_run_id, workflow_node_id)`.
   - **Data migration from `space_tasks`:** `INSERT INTO node_executions (...) SELECT ... FROM space_tasks WHERE workflow_node_id IS NOT NULL`. The `WHERE workflow_node_id IS NOT NULL` guard is **required** — omitting it would silently create orphaned rows for orchestration tasks and standalone tasks. Map fields: `workflow_node_id` → `workflow_node_id`, `agent_name` → `agent_name`, `custom_agent_id` → `agent_id`, `task_agent_session_id` → `agent_session_id`. Map status: `completed` → `done`, `needs_attention` → `blocked`, `rate_limited` → `blocked`, `usage_limited` → `blocked`, `draft` → `pending`, `pending` → `pending`, `review` → `in_progress`. The `workflow_run_id` column exists directly on `space_tasks` — use it. Leave `result` as null — `space_tasks.description` is the task description, not execution output, and should not be used as `result`.

3. **`space_workflows` migration:**
   - Add column: `ALTER TABLE space_workflows ADD COLUMN end_node_id TEXT`.
   - Drop columns by table recreation: remove `config` JSON blob (which contains `rules`, `maxIterations`). Note: `isDefault` exists only in the TypeScript type (`SpaceWorkflow`, `CreateSpaceWorkflowParams`, `UpdateSpaceWorkflowParams`), not as a DB column or repository field — no DB migration is needed for it. It is removed from the TypeScript types in Task 1.3.
   - **Note:** As of this writing, migration 70 is taken by the rooms `default_path` backfill (PR #1177); start at **71**. Always verify at implementation time in case a concurrent migration is merged first. These migrations will span multiple migration numbers (71, 72, 73, …) — one per logical table change, or batched where appropriate.

4. **`space_workflow_runs` migration:**
   - Recreate table dropping: `config`, `goal_id`, `iteration_count`, `max_iterations`. **Keep `failure_reason`** — it is the state discriminator for the gate approval/rejection flow (`approve_gate` checks `run.failureReason === 'humanRejected'`; `reject_gate` sets it). Moving rejection state into gate data is a separate future effort.
   - Add `started_at` (INTEGER nullable) — does not currently exist. Keep `completed_at` (already present).
   - Update `status` CHECK constraint to new values: `pending`, `in_progress`, `done`, `blocked`, `cancelled`.

5. **`space_workflow_nodes` migration:**
   - Drop `order_index` column if it exists as a top-level column.
   - If `agent_id` is stored as a top-level column, remove it (agents are stored in node config JSON as `agents[]`).
   - `model` and `system_prompt` are stored inside the `config` JSON blob, not as top-level DB columns — no column-level migration needed. The JSON blob serialization is updated in Task 3 (repository layer) to stop reading/writing these fields.

6. **`space_agents` migration:**
   - Recreate table dropping: `role`, `config` (which stores `toolConfig`), `inject_workflow_context`.
   - Add: `instructions TEXT DEFAULT NULL` column.
   - Also update the `space_workflow_nodes` node config JSON: the `config` blob currently stores `{ systemPrompt, instructions, agents[] }` where `instructions` on the node and `systemPrompt`/`instructions` on each `WorkflowNodeAgent` entry are plain strings. Migrate to the new `WorkflowNodeAgent` shape: `systemPrompt?: { mode: 'override' | 'expand', value: string }` and `instructions?: { mode: 'override' | 'expand', value: string }`. For existing data where these are plain strings, migrate to `{ mode: 'override', value: existingString }` (preserve existing behavior — override was implicit). **Guards:** (a) If the existing value is `null`, `undefined`, or empty string, leave it absent (do NOT create `{ mode: 'override', value: null }`). (b) If the existing value is already an object with a `mode` property (`typeof value === 'object' && value.mode`), skip it — prevents double-wrap on re-run. The node-level `instructions` and `systemPrompt` fields on `WorkflowNode` are dropped entirely.

**Acceptance criteria:**
- All migrations run without errors on existing databases with data.
- Data is preserved: existing tasks, workflows, workflow runs, agents are migrated to new schema.
- Status values are correctly mapped (old → new).
- Node execution data is migrated from `space_tasks` to `node_executions`.
- Indexes exist on `node_executions` for query performance.
- Each table recreation is wrapped in a transaction (BEGIN/COMMIT) to prevent inconsistent state if migration fails partway through. This is the standard pattern in this codebase (see migrations 51, 55, 60, 62).
- Per-migration test files written (e.g., `migration-71.test.ts`, `migration-72.test.ts`) covering: status mapping correctness, `node_executions` backfill from `space_tasks` with `WHERE workflow_node_id IS NOT NULL`, column presence/absence after recreation, data preservation round-trip.

**Dependencies:** Task 1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 3: Repository layer updates

**Description:** Update all repository classes to read/write the new schema. Add the new `NodeExecutionRepository`.

**Agent type:** coder

**Subtasks:**

1. **`NodeExecutionRepository` (new):**
   - Create `packages/daemon/src/storage/repositories/node-execution-repository.ts`.
   - Implement CRUD: `create()`, `getById()`, `listByWorkflowRun()`, `listByNode()`, `updateStatus()`, `updateSessionId()`.
   - `listByWorkflowRun()` replaces the current `taskRepo.listByWorkflowRun()` for workflow-internal queries.

2. **`SpaceTaskRepository` updates:**
   - Update `TaskRow` interface to match new columns. Remove `workflow_node_id`, `agent_name`, `custom_agent_id`, `task_type`, `goal_id`, `error`, `assigned_agent`. **Keep** `task_agent_session_id` (orchestration task's session) and `workflow_run_id`.
   - Add `task_number`, `labels`, `depends_on`, `result`, `started_at`, `completed_at`, `archived_at`.
   - Update `rowToTask()` and `createTask()` / `updateTask()` methods.
   - Remove `listByWorkflowRun()`, `findByGoalId()` — these are workflow-internal queries that move to `NodeExecutionRepository`. Keep `listActiveWithTaskAgentSession()` (still used for orchestration task rehydration).

3. **`SpaceWorkflowRepository` updates:**
   - Add `end_node_id` to `WorkflowRow` and `rowToWorkflow()`.
   - Add `endNodeId` to `createWorkflow()` and `updateWorkflow()`. Use `params.endNodeId !== undefined` pattern for updates (consistent with `startNodeId`). Add inline comment: `// undefined = not provided (no change), null = clear the field, string = set new value`.
   - Remove reading/writing of `config` JSON blob fields (`rules`, `maxIterations`), `isDefault`.

4. **`SpaceWorkflowRunRepository` updates:**
   - Remove `config`, `goalId`, `iterationCount`, `maxIterations` from row mapping and CRUD.
   - **Keep `failureReason`** — it is the state discriminator for the gate approval/rejection flow (see Task 2 note). Do not remove from row mapping.
   - Add `startedAt`, `completedAt` if not present.
   - Update status values in transition logic.

5. **`SpaceAgentRepository` updates:**
   - Remove `role`, `config` (toolConfig), `inject_workflow_context` from row mapping and CRUD.

6. **Unit tests:**
   - New test file for `NodeExecutionRepository`: CRUD, status transitions, query by run/node.
   - Update existing repository tests for changed fields/status values.

**Acceptance criteria:**
- All repositories compile and pass their unit tests.
- `NodeExecutionRepository` has full CRUD coverage.
- Old fields are no longer read/written.
- `bun run typecheck` passes.

**Dependencies:** Task 1, Task 2

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 4: SpaceTaskManager and status transition updates

**Description:** Update `SpaceTaskManager`, `VALID_SPACE_TASK_TRANSITIONS`, and `TERMINAL_TASK_STATUSES` to use new status values. Create `NodeExecutionManager` for workflow-internal execution state.

**Agent type:** coder

**Subtasks:**

1. **`SpaceTaskManager` updates:**
   - Update `VALID_SPACE_TASK_TRANSITIONS` for new `SpaceTaskStatus` values: `open`, `in_progress`, `done`, `blocked`, `cancelled`, `archived`.
   - Update `setTaskStatus()`, `retryTask()`, `reassignTask()` for new status names.
   - Remove any workflow-specific logic (the manager now handles only user-facing tasks).

2. **`NodeExecutionManager` (new or extend existing):**
   - Create status transition logic for `NodeExecutionStatus`: `pending` → `in_progress`, `in_progress` → `done`/`blocked`/`cancelled`, `blocked` → `in_progress`/`cancelled`, etc.
   - `TERMINAL_NODE_EXECUTION_STATUSES`: `done`, `cancelled`.
   - This manager is used by the runtime, node-agent-tools, and CompletionDetector.

3. **`WorkflowRunStatusMachine` updates (`packages/daemon/src/lib/space/runtime/workflow-run-status-machine.ts`):**
   - Update the `VALID_TRANSITIONS` map: rename `completed` → `done`, `needs_attention` → `blocked` (lines 31–35). This is the canonical state transition table for `WorkflowRunStatus` and is imported by `space-workflow-run-repository.ts`, `space-agent-tools.ts`, and `global-spaces-tools.ts` via `canTransition`/`assertValidTransition`.
   - Update unit test `workflow-run-status-lifecycle.test.ts`: parameterized tests over all `WorkflowRunStatus` values must use the new names.

4. **Update `CompletionDetector`:**
   - Change from querying `taskRepo.listByWorkflowRun()` to `nodeExecutionRepo.listByWorkflowRun()`.
   - Filter by `NodeExecution` instead of `SpaceTask`.
   - Update `TERMINAL_TASK_STATUSES` reference to `TERMINAL_NODE_EXECUTION_STATUSES` (`done`, `cancelled`).
   - Refactor `isComplete()` signature to options object: `isComplete(options: { workflowRunId: string, channels?: WorkflowChannel[], nodes?: WorkflowNode[], endNodeId?: string })`.
   - Add end-node completion logic: if `endNodeId` is provided, find the `NodeExecution` with matching `workflowNodeId` and check for terminal status. Short-circuit on match.
   - **Update ALL call sites** to new signature: `space-runtime.ts` and `task-agent-tools.ts` (the latter is removed in Task 6, but must compile in this task).

5. **Unit tests:**
   - Update `completion-detector.test.ts`: all existing tests updated for new types/repo, plus new end-node tests.
   - New tests for `NodeExecutionManager` status transitions.
   - Update `workflow-run-status-lifecycle.test.ts` for renamed status values.
   - Parameterized test over all `TERMINAL_NODE_EXECUTION_STATUSES`.

**Acceptance criteria:**
- New status values used consistently.
- CompletionDetector queries `node_executions` instead of `space_tasks`.
- End-node completion logic works as specified in prior iterations (bypass, orchestration task cleanup, etc.).
- All tests pass.

**Dependencies:** Task 1, Task 3

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 5: Runtime updates (ChannelRouter, SpaceRuntime, TaskAgentManager)

**Description:** Update the workflow runtime layer to use `node_executions` instead of `space_tasks` for workflow-internal state. This is the core behavioral change.

**Agent type:** coder

**Subtasks:**

1. **`ChannelRouter` updates (`packages/daemon/src/lib/space/runtime/channel-router.ts`):**
   - `activateNode()`: create `NodeExecution` records via `nodeExecutionRepo.create()` instead of creating `space_tasks` with `workflowNodeId`. Remove `taskType`, `goalId`, `customAgentId` from node activation.
   - **Fix `description` fallback chain** (line 244): The current code uses `agentEntry.instructions ?? node.instructions ?? ''` for the node execution description. After migration, `node.instructions` is removed from the type. Update to use the resolved `instructions` value: if `agentEntry.instructions` is a `{ mode, value }` object, resolve it against the agent's base `instructions` using the same composition logic as `createCustomAgentInit` (or extract a shared helper). Remove the `?? node.instructions` fallback entirely.
   - `getActiveExecutionsForNode()`: query `nodeExecutionRepo.listByNode()` instead of filtering tasks.
   - Update channel routing to use `NodeExecution.agentName` for message delivery.

2. **`SpaceRuntime` updates (`packages/daemon/src/lib/space/runtime/space-runtime.ts`):**
   - `processRunTick()`: fetch `NodeExecution` records via `nodeExecutionRepo.listByWorkflowRun()` instead of tasks.
   - End-node bypass: before the `needs_attention` (now `blocked`) early-return block, check if end node's execution is `done` — skip the block if so.
   - Pass `endNodeId` to `completionDetector.isComplete()`.
   - **Orchestration task completion on auto-complete:** When the runtime auto-completes a run, find the orchestration task (task with no corresponding node execution, or a designated orchestration task) and complete it. Use `this.getOrCreateTaskManager(meta.spaceId)` for status update. Guard: only if status is `in_progress`. **`daemonHub` injection:** Add `daemonHub` field to `SpaceRuntimeConfig` interface (it currently exists only on `SpaceRuntimeServiceConfig`). Update `SpaceRuntimeService` to pass `daemonHub` through when constructing `SpaceRuntime`. This is required for emitting `space.task.done` events from the runtime. **Test setup update:** `SpaceRuntimeConfig` is consumed in `SpaceRuntime`, `SpaceRuntimeService`, and test setup files (e.g., `space-runtime-completion.test.ts`, `channel-router.test.ts`). All test files that construct `SpaceRuntimeConfig` must be updated to include the new `daemonHub` field (use a mock/stub).
   - **Sibling `NodeExecution` cleanup:** When the end-node completes and the run transitions to `done`, sibling `NodeExecution` records still `in_progress` are **cancelled** (set to `cancelled` status). For each cancelled execution with a non-null `agentSessionId`, call `TaskAgentManager.cancelBySessionId(agentSessionId)` to terminate the backing sub-session (see Task 5.3 for the new method). This prevents `AgentLiveness` from monitoring or re-activating stale sessions and ensures `nodeExecution.list` shows a clean final state on the frontend canvas. Add code comment documenting this behavior.
   - **Notification tradeoff:** When end-node bypass fires, `blocked` notifications for sibling executions are skipped. Add code comment.

3. **`TaskAgentManager` updates (`packages/daemon/src/lib/space/runtime/task-agent-manager.ts`):**
   - Read `NodeExecution.agentSessionId` instead of `task.taskAgentSessionId` for session lookup/restore.
   - Write `agentSessionId` to `NodeExecution` after spawning via `nodeExecutionRepo.updateSessionId()`.
   - `handleSubSessionComplete`/`handleSubSessionError`: match by `NodeExecution.agentSessionId` instead of `task.taskAgentSessionId`.
   - `listActiveWithTaskAgentSession()` equivalent: query `nodeExecutionRepo` for executions with non-null `agentSessionId` and non-terminal status.
   - **Add `cancelBySessionId(agentSessionId: string): Promise<void>` public method.** The existing `cleanup(taskId, reason)` uses `taskId` to find sessions in an internal map (`taskAgentSessions: Map<taskId, AgentSession>`, `subSessions: Map<taskId, Map<sessionId, AgentSession>>`), but after migration sibling cancellation needs to terminate sessions by `agentSessionId` (no `taskId` available). Implementation: add a reverse index `Map<agentSessionId, AgentSession>` (similar to existing `sessionListeners` which already uses session IDs as keys), populated on session creation and cleared on removal. `cancelBySessionId` looks up the reverse index in O(1) and calls `stopAndDeleteSession()`. This method is called by Task 5.2's sibling cleanup logic.
   - **Rehydration:** `TaskAgentManager.rehydrate()` currently queries `WHERE task_agent_session_id IS NOT NULL` on `space_tasks`. After migration, orchestration task sessions are still rehydrated via `space_tasks.task_agent_session_id` (kept). Node agent sessions are rehydrated via `nodeExecutionRepo` query for executions with non-null `agentSessionId` and non-terminal status. Update `rehydrate()` to query both sources.

4. **`AgentLiveness` updates (`packages/daemon/src/lib/space/runtime/agent-liveness.ts`):**
   - Line 81 references `task.taskAgentSessionId` — update to query `NodeExecution.agentSessionId` via `nodeExecutionRepo`.
   - Update status checks from old values (`in_progress`) to new `NodeExecutionStatus` values.
   - Liveness checks now operate on `NodeExecution` records, not `SpaceTask`.

5. **`AgentMessageRouter` updates (`packages/daemon/src/lib/space/runtime/agent-message-router.ts`):**
   - Lines 27, 104 reference `workflowNodeId` on space tasks — update to look up via `nodeExecutionRepo`.
   - Lines 132, 135 reference `taskAgentSessionId` and `agentName` on space tasks — update to use `NodeExecution.agentSessionId` and `NodeExecution.agentName`.
   - Message routing must resolve the correct `NodeExecution` for a given agent session.

6. **Live query updates (`packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts`):**
   - `SPACE_TASK_ACTIVITY_BY_TASK_SQL` (lines 564–648): **fundamentally restructure the query.** The current query uses a CTE that filters `space_tasks.task_agent_session_id IS NOT NULL` to find sub-sessions, then joins to `sessions` and `sdk_messages`. After migration, `task_agent_session_id` moves to `node_executions`. The new query structure:
     - **Two-leg query structure:**
       - **Leg 1 (orchestration task session):** `space_tasks` → `sessions` (via `space_tasks.task_agent_session_id = sessions.id`), rendered as `kind: 'task_agent'`. This uses the kept `task_agent_session_id` column on `space_tasks`.
       - **Leg 2 (node agent sub-sessions):** `space_tasks` → `node_executions` (via `space_tasks.workflow_run_id = node_executions.workflow_run_id`) → `sessions` (via `node_executions.agent_session_id = sessions.id`) → `sdk_messages`, rendered as `kind: 'node_agent'`.
       - Combine with UNION ALL.
     - **Remove** the workflow-internal columns from the SELECT (`workflow_node_id`, `agent_name`, `custom_agent_id`, `current_step`, `completion_summary`, `error`).
     - The `SpaceTaskActivityMember` optional `nodeExecution?` sub-object (Task 1.7) is populated separately via the `nodeExecutions.byRun` LiveQuery (Task 11.3) on the frontend — the daemon query does not need to inline it.
   - `SPACE_TASK_MESSAGES_BY_TASK_SQL` — similarly check for references to removed columns and update.
   - Remove references to `taskType` and `assignedAgent` (6 occurrences).

7. **`NotificationSink` and `SessionNotificationSink` updates:**
   - `packages/daemon/src/lib/space/runtime/notification-sink.ts`: update `WorkflowRunCompleted.status` union from `'completed' | 'cancelled' | 'needs_attention'` to `'done' | 'cancelled' | 'blocked'`. Rename event kinds: `task_needs_attention` → `task_blocked`, `workflow_run_needs_attention` → `workflow_run_blocked`.
   - `packages/daemon/src/lib/space/runtime/session-notification-sink.ts` (line 191): update mirrored status references to match. Line 260 includes `failureReason: 'agentCrash'` in a notification payload — this is a notification payload field (not the DB column) and should be kept as-is since `failureReason` is preserved.

8. **`WorkflowExecutor` updates (`packages/daemon/src/lib/space/runtime/workflow-executor.ts`):**
   - Line 143: update `this.run.status === 'completed'` → `this.run.status === 'done'`. Keep `cancelled` as-is.

9. **`SpaceRuntimeService` updates (`packages/daemon/src/lib/space/runtime/space-runtime-service.ts`):**
   - Inject `NodeExecutionRepository` into the runtime config so all runtime components can access it.
   - Update any direct `SpaceTaskRepository` usage for workflow-internal queries to use `NodeExecutionRepository`.

10. **Unit tests:**
   - Update `space-runtime-completion.test.ts` for new types.
   - Update `channel-router.test.ts` for `NodeExecution` creation.
   - Update `task-agent-manager.test.ts` for session tracking via `NodeExecution`.
   - Add/update tests for `agent-liveness.ts` and `agent-message-router.ts`.
   - Update notification sink tests for renamed event kinds and status values.

**Acceptance criteria:**
- Runtime creates `NodeExecution` records, not task-level records for workflow nodes.
- Session tracking uses `NodeExecution.agentSessionId`.
- Agent liveness checking queries `node_executions` instead of `space_tasks`.
- Agent message routing uses `NodeExecution` for session/node resolution.
- Live queries (`SPACE_TASK_ACTIVITY_BY_TASK_SQL`, `SPACE_TASK_MESSAGES_BY_TASK_SQL`) updated for new schema.
- End-node completion flow works: end node `done` → bypass → CompletionDetector → run `done` → orchestration task completed.
- All runtime tests pass.

**Dependencies:** Task 3, Task 4

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 6: Remove `report_workflow_done` and update agent tools

**Description:** Remove `report_workflow_done` from Task Agent tools, update node-agent-tools to work with `NodeExecution`, and update system prompts.

**Agent type:** coder

**Subtasks:**

1. **Remove `report_workflow_done`:**
   - Remove `ReportWorkflowDoneSchema` from `task-agent-tool-schemas.ts`.
   - Remove handler from `task-agent-tools.ts`.
   - Remove `completionDetector` from `TaskAgentToolsConfig` (defined at ~line 195 in `task-agent-tools.ts`). Remove the `CompletionDetector` import.
   - Remove both `new CompletionDetector()` instantiations in `task-agent-manager.ts` (~lines 630 and 1449).
   - Update `TaskResultStatusSchema` in `task-agent-tool-schemas.ts` from `z.enum(['completed', 'needs_attention', 'cancelled'])` to `z.enum(['done', 'blocked', 'cancelled'])`. Update `ReportResultSchema` description strings.
   - **Update `report_result` event conditional** in `task-agent-tools.ts`: change `status === 'completed' ? 'space.task.completed' : 'space.task.failed'` to `status === 'done' ? 'space.task.done' : 'space.task.failed'`. Without this, the `status === 'completed'` branch becomes dead code after the enum change, causing all completions to emit `space.task.failed`.
   - **`space.task.failed` — keep as-is.** The `space.task.failed` event (declared in `daemon-hub.ts` line ~465, subscribed in `provision-global-agent.ts` line ~207) is not renamed. It fires when `report_result` status is `blocked` or `cancelled`. The `blocked` status is recoverable, but `space.task.failed` is the correct notification — the agent's work failed or was blocked, which requires attention. **Verification subtask:** After renaming, confirm that `provision-global-agent.ts` subscriber (line ~207) handles `blocked` status appropriately — it should not treat `blocked` as a hard terminal failure if it triggers retry logic. Add a code comment at the subscriber documenting that `blocked` is recoverable while `cancelled` is terminal.
   - Update `daemon-hub.ts`: rename the typed event declaration from `'space.task.completed'` to `'space.task.done'` (line ~455). Keep `'space.task.failed'` as-is.
   - Update `provision-global-agent.ts`: update the event subscription from `'space.task.completed'` to `'space.task.done'` (line ~193), and update the log string (line ~223). Keep `'space.task.failed'` subscription as-is.

2. **Update `node-agent-tools.ts`:**
   - `report_done`: update to set `NodeExecution.status = 'done'` via `nodeExecutionRepo` instead of `taskManager.setTaskStatus(stepTaskId, 'completed')`.
   - `list_peers`: query `nodeExecutionRepo` by `workflowRunId` instead of filtering tasks by `workflowNodeId`.
   - `send_message`: use `NodeExecution.agentName` for routing.

3. **Update `task-agent-tools.ts`:**
   - `spawn_node_agent`: read `NodeExecution.agentSessionId` for idempotency guard instead of `task.taskAgentSessionId`. Write `agentSessionId` to `NodeExecution` after session creation.
   - `list_group_members`: query `nodeExecutionRepo` instead of filtering tasks.

4. **Update Task Agent system prompt (`task-agent.ts`):**
   - Remove `report_workflow_done` documentation section.
   - Update step 6: "The workflow runtime automatically detects completion when the end node finishes. You do not need to detect or signal workflow completion."
   - Update step 4: "Monitoring task progress — the workflow runtime handles completion automatically when the end node finishes."
   - Note: Task Agent does NOT call `report_result` to self-terminate — runtime auto-completes.
   - **Cross-ref Task 11.6:** Document the `get_workflow_run` output contract change in the system prompt — the tool now returns `{ run, executions }` (where `executions` is `NodeExecution[]`) instead of `{ run, tasks }`. The Task Agent must know execution status lives in `executions`, not `tasks`.

5. **Update tests:**
   - Remove `report_workflow_done` tests from `task-agent-tool-schemas.test.ts`, `task-agent-tools.test.ts`, `task-agent-collaboration.test.ts`.
   - Update `node-agent-tools.test.ts` for `NodeExecution` usage.
   - Update prompt assertion tests in `task-agent.test.ts`.

**Acceptance criteria:**
- `report_workflow_done` completely removed.
- Node agent tools use `NodeExecution` for state management.
- Task agent tools use `NodeExecution` for session tracking.
- All tests pass, lint passes (no dead imports/exports).

**Dependencies:** Task 4, Task 5

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 7: Agent and utility cleanup

**Description:** Remove `SpaceAgent.role` and related utilities, remove `WorkflowNode.agentId` shorthand handling, clean up `resolveNodeAgents()`.

**Agent type:** coder

**Subtasks:**

1. **Remove `SpaceAgent.role` usage:**
   - Remove `getFeaturesForRole()` from `packages/daemon/src/lib/space/agents/seed-agents.ts`. **Replacement:** `SessionFeatures` should be derived from `SpaceAgent.tools[]` array instead of the role string. If `tools` is empty, use sensible defaults (equivalent to current `DEFAULT_ROLE_FEATURES`).
   - Remove `resolveTaskTypeForAgent()` from `channel-router.ts` and `space-runtime.ts` — task type is no longer needed since `node_executions` don't have a `taskType` field. Remove `SpaceTaskType` type definition from `space.ts` (it becomes a dead export once `resolveTaskTypeForAgent()` and `SpaceTask.taskType` are removed — knip will flag it).
   - Remove `getRoleLabel()` usage.
   - Update `custom-agent.ts` (lines 182, 201): replace `getFeaturesForRole(agent.role)` with the new tools-based feature resolution.
   - Update `task-agent.ts` (line 495): the agent iteration that prints `role:` in the system prompt — remove the `role` field from the printed output, replace with agent `description` or `name`.
   - Update `space-chat-agent.ts` (line 132): remove `role: ${agent.role}` from the context string, replace with agent `description` or omit.

2. **Remove `WorkflowNode.agentId` shorthand:**
   - Update `resolveNodeAgents()` in `space-utils.ts`: **keep the `agentId` fallback as a permanent compat shim** — convert `agentId` to `agents: [{ agentId }]` silently. Do NOT throw. `resolveNodeAgents()` is called in the runtime tick loop (`space-runtime.ts`, `channel-router.ts`, `task-agent-tools.ts`) and throwing would crash production workflow runs on pre-migration workflows. The editor boundary (Task 10.5) handles normalization on save.
   - Remove `agentId` from the `WorkflowNode` TypeScript type (Task 1.5) — the compat shim in `resolveNodeAgents()` handles persisted legacy data at runtime. **Type cast for compat shim:** Since `agentId` is removed from the type, the shim must use `(node as Record<string, unknown>).agentId` (or define a `LegacyWorkflowNode` intersection type) to read the field from persisted JSON without triggering TypeScript errors. The same cast is needed for `node.instructions` (line 101) and `node.systemPrompt` (line 100) in the legacy `agentId` fallback branch, since both fields are removed from `WorkflowNode`. Do NOT use `@ts-ignore` or `any` (oxlint `no-explicit-any` will flag it).
   - Update all callers of `resolveNodeAgents()` (20+ call sites) to not reference `node.agentId` directly — always go through `resolveNodeAgents()`.
   - Update `space_workflow_nodes` DB handling to not write `agent_id` on new records.

3. **Update `SlotOverrides` interface and wiring in `custom-agent.ts`:**
   - **`SlotOverrides` interface** (line 28 in `custom-agent.ts`): Change `systemPrompt?: string` to `systemPrompt?: { mode: 'override' | 'expand'; value: string }`. Add `instructions?: { mode: 'override' | 'expand'; value: string }` (currently absent from `SlotOverrides` — `instructions` was never wired through to `createCustomAgentInit`).
   - **Consumer update** in `task-agent-tools.ts` (line 333): Update `const slotOverrides = { model: agentSlot?.model, systemPrompt: agentSlot?.systemPrompt }` to also include `instructions: agentSlot?.instructions`. Without this, the `instructions` override/expand feature is silently inert — the structured object never reaches `createCustomAgentInit`.
   - **Composition logic** in `createCustomAgentInit()` and `buildCustomAgentSystemPrompt()`: Implement the two-layer composition for both `systemPrompt` and `instructions`:
     - If `slot.systemPrompt` is absent → use `agent.systemPrompt` as-is.
     - If `slot.systemPrompt.mode === 'override'` → use `slot.systemPrompt.value` (replaces agent's value entirely).
     - If `slot.systemPrompt.mode === 'expand'` → concatenate `agent.systemPrompt + "\n\n" + slot.systemPrompt.value`.
     - Apply identical logic for `instructions`.
   - **`resolveNodeAgents()` return value:** After this change, `resolveNodeAgents()` returns `WorkflowNodeAgent[]` where `systemPrompt` and `instructions` are the raw structured `{ mode, value }` objects (or `undefined`). The function no longer performs prompt resolution — it just passes through whatever the slot has. Composition happens in `createCustomAgentInit`.
   - Remove the old `WorkflowNode.systemPrompt` spreading behavior in `resolveNodeAgents()` (lines 89–90 in `space-utils.ts`). The compat shim for `agentId` (Task 7.2) must also handle `node.instructions` with the same type-cast treatment as `node.agentId` — since `WorkflowNode.instructions` is removed from the type, use `(node as Record<string, unknown>).instructions` in the legacy `agentId` fallback branch (line 101).

4. **Remove `SpaceAgent.injectWorkflowContext`:**
   - Remove from `neo-query-tools` display logic.
   - Remove from repository mapping.

5. **Unit tests:**
   - Update `seed-agents.test.ts`, `custom-agent.test.ts` for role removal.
   - Update any tests that use `resolveNodeAgents()` with `agentId` shorthand.
   - Add tests for override/expand composition logic (override replaces, expand concatenates, absent uses base).

**Acceptance criteria:**
- `SpaceAgent.role`, `toolConfig`, `injectWorkflowContext` fully removed.
- `WorkflowNode.agentId` shorthand fully removed — only `agents[]` accepted.
- `resolveNodeAgents()` simplified.
- Override/expand composition implemented and tested for both `systemPrompt` and `instructions`.
- All tests pass, lint passes (no dead exports via knip check).

**Dependencies:** Task 1, Task 3

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 8: Built-in workflow templates

**Description:** Update built-in workflow templates for new schema: add `endNodeId`, remove `agentId` shorthand, ensure `agents[]` array format.

**Agent type:** coder

**Subtasks:**

1. In `packages/daemon/src/lib/space/workflows/built-in-workflows.ts`:
   - `CODING_WORKFLOW`: add `endNodeId: CODING_DONE_STEP`. Ensure all nodes use `agents: [...]` not `agentId`.
   - `CODING_WORKFLOW_V2`: add `endNodeId: V2_DONE_STEP`.
   - `RESEARCH_WORKFLOW`: add `endNodeId: RESEARCH_GENERAL_STEP`. Add comment: `// Terminal in current 2-node topology; update endNodeId if topology changes`.
   - `REVIEW_ONLY_WORKFLOW`: add `endNodeId: REVIEW_CODER_STEP`. Add comment: `// Single-node workflow — start and end are the same node. CompletionDetector still requires the end-node execution to reach 'done' status; it does not short-circuit on first tick.` This is intentional and valid.
2. In `seedBuiltInWorkflows()`, add `endNodeId` mapping through `nodeIdMap`. Use non-null assertion (`!`) consistent with `startNodeId` — throws on mismatch.
3. Remove any `config`, `rules`, `maxIterations`, `isDefault` from template definitions.
4. Update tests in `built-in-workflows.test.ts`:
   - Assert each template has `endNodeId` set and references a valid node.
   - Assert `REVIEW_ONLY_WORKFLOW` has `startNodeId === endNodeId`.
   - Assert all nodes use `agents[]` not `agentId`.

**Acceptance criteria:**
- All templates define `endNodeId` and use `agents[]` format.
- Deprecated fields removed from templates.
- All tests pass.

**Dependencies:** Task 1, Task 3, Task 7

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 9: Export/import format updates

**Description:** Update export/import to handle new schema: `endNode`, removed fields, `agents[]` format, `NodeExecution` data.

**Agent type:** coder

**Subtasks:**

1. **Zod schema updates** (`packages/daemon/src/lib/space/export-format.ts`):
   - **`exportedWorkflowNodeAgentSchema`** (line 62): Change `systemPrompt: z.string().optional()` to a union that accepts both legacy plain strings and new structured objects: `systemPrompt: z.union([z.string(), z.object({ mode: z.enum(['override', 'expand']), value: z.string() })]).optional()`. Same for `instructions`. This allows the Zod validator to accept both legacy exports (plain string) and new exports (`{ mode, value }`).
   - **`exportedWorkflowNodeSchema`** (line 84): Remove `systemPrompt: z.string().optional()`, `instructions: z.string().optional()`, and `model: z.string().optional()` — these node-level fields are removed (Task 1.10).
   - **`exportedWorkflowBaseSchema`** (line 133): Add `endNode: z.string().min(1).optional()` — validates the optional `endNode` field on import. For `rules`: do NOT hard-remove from the Zod schema — legacy exports will still contain `rules` arrays. Instead, keep `rules` as `z.array(exportedWorkflowRuleSchema).optional()` (change from required to optional) so legacy exports pass validation, then strip `rules` during import processing (do not persist). Alternatively, use `.passthrough()` on the schema so unknown fields are accepted and silently ignored. Either approach prevents legacy export bundles from being rejected at the Zod validation layer.
   - **`exportedAgentBaseSchema`** (line 121): Add `instructions: z.string().optional()`. Remove `role: z.string().min(1)` (role is removed). Remove `config: z.record(...)` (toolConfig is removed).
2. **Export format** (`packages/daemon/src/lib/space/export-format.ts`):
   - Add `endNode` mapping (UUID → name), optional.
   - Remove export of `rules`, `config`, `maxIterations`, `isDefault` from workflow export.
   - Remove `role`, `toolConfig`, `injectWorkflowContext` from agent export.
   - Export `SpaceAgent.instructions` field (nullable string) for each agent in the export.
   - Ensure node export uses `agents[]` not `agentId`.
   - Export `WorkflowNodeAgent.systemPrompt` and `.instructions` using the new structured shape `{ mode, value }` — these are already the in-memory representation after Task 1, so no special mapping is needed for new data.
3. **Import handling** (`space-export-import-handlers.ts`):
   - Resolve `endNode` name → UUID on import. The Zod schema (subtask 1) accepts the optional `endNode` field; the import handler resolves the node name to a UUID using the same `nameToId` map pattern as `startNode`.
   - Handle importing legacy exports that have `agentId` on nodes: convert to `agents[]` during import.
   - Handle importing legacy exports with old status values: map to new values.
   - When importing legacy exports where `WorkflowNodeAgent.systemPrompt` or `.instructions` is a plain string (not `{ mode, value }`), convert to `{ mode: 'override', value: existingString }` at import time. This matches the DB migration behavior (Task 2.6).
   - When importing `SpaceAgent`, handle missing `instructions` field gracefully (set to `null`).
4. **Tests:**
   - Update `export-format.test.ts` and `export-import-round-trip.test.ts`.
   - Add test for legacy export import (backward compat).
   - Test for legacy export with plain-string `WorkflowNodeAgent.systemPrompt` — verifies it imports as `{ mode: 'override', value }`.
   - Test Zod schema accepts both plain string and `{ mode, value }` for `systemPrompt`/`instructions`.

**Acceptance criteria:**
- Export includes `endNode` when set; omits deprecated fields.
- Import handles both new and legacy export formats.
- Round-trip preserves all data.

**Dependencies:** Task 1, Task 3

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 10: Visual editor and form editor updates

**Description:** Update frontend workflow editors for new schema: `endNodeId` support, `agentId` shorthand removal, removed fields.

**Agent type:** coder

**Subtasks:**

1. **Visual editor serialization** (`serialization.ts`):
   - Add `endNodeId` to `VisualEditorState`, `workflowToVisualState()`, `buildWorkflowFields()`, `visualStateToCreateParams()`, `visualStateToUpdateParams()`.
   - Remove `agentId` shorthand handling — always use `agents[]`.
   - Remove deprecated fields from serialization.
2. **Visual editor UI** (`VisualWorkflowEditor.tsx`):
   - Add `endNodeId` state, wire to serialization.
   - Pass to `NodeConfigPanel`.
   - Update `tasksByNodeId` usage (line 406): add a temporary `computed(() => new Map())` shim for `tasksByNodeId` in this file (or import from `space-store.ts`) so the component compiles without the old signal. Task 13 replaces this shim with the real `nodeExecutionsByNodeId` signal.
3. **NodeConfigPanel** (`NodeConfigPanel.tsx`):
   - Add "Set as End Node" button (parallel to "Set as Start Node").
   - Show "END" badge on end nodes.
   - Line 286: remove `{' (${agent.role})'}` display — replace with agent description or omit.
   - For each agent slot in the node config (`WorkflowNodeAgent`), replace plain text inputs for `systemPrompt` and `instructions` with a compound field: a mode selector (`<select>` with `override` / `expand` options) paired with a textarea for `value`. When the field is absent/cleared, the select and textarea should be hidden (no override). **Default mode for new overrides:** When a user adds a new override via the UI, default to `'expand'` (most common use case is additive context on top of the base agent). The `'override'` mode is reserved for migration of legacy data (Task 2.6) and explicit user choice. This gives authors explicit control over whether the slot overrides or expands the agent's base values.
4. **Visual editor canvas** (`packages/web/src/components/space/visual-editor/WorkflowCanvas.tsx`):
   - Lines 155–165: remove `agentRoleToNodeId` map that uses `agent.role`. Replace role-based slot labeling with `agent.name` or `agent.description`.
   - Line 160: remove `agent.role` reference in node rendering.
5. **WorkflowEditor (form-based)** (`WorkflowEditor.tsx`):
   - Pass `endNodeId` in create/update params. For new workflows, default to last node. For updates, preserve existing. Add comment: `// Heuristic for new workflows: defaults to last node — use the visual editor for explicit control`.
   - Remove `NodeDraft.agentId` — replace with `NodeDraft.agents: WorkflowNodeAgent[]`. Update `buildTemplateNodes()` (line ~366) to populate `agents[]` instead of `agentId`. Update `workflowToEditorState()` (lines ~429–453) to reconstruct drafts using `node.agents` (the DB migration in Task 2.5 does not rewrite node config JSON — `agentId` may still exist in persisted data). Add a compat guard: if a loaded node has only `agentId` in its config, convert to `agents: [{ agentId }]` at the editor boundary. Replace the single agent dropdown with the `agents[]` editor pattern.
   - Remove `NodeDraft.model` and `NodeDraft.systemPrompt` fields (these are being removed from `WorkflowNode` — see Task 1.5). Remove corresponding form inputs.
   - Remove other deprecated field inputs.
6. **WorkflowNodeCard** (`WorkflowNodeCard.tsx`):
   - Remove `node.agentId` references (lines 31, 219, 241, 246, 292, 686, 730, 841, 846) — use `node.agents[0]` or the agents list.
   - Update `AgentTaskState` status checks: `state.status === 'completed'` (line 79) → `'done'`, `state.status === 'needs_attention'` (line 160) → `'blocked'`.
7. **SpaceAgentList** (`SpaceAgentList.tsx`):
   - Line 141 filters `step.agentId === agentId` for agent deletion confirmation — update to check `node.agents.some(a => a.agentId === agentId)`.
8. **Tests:**
   - Serialization test for `endNodeId` round-trip.
   - NodeConfigPanel "Set as End Node" button test.

**Acceptance criteria:**
- `endNodeId` supported in both editors.
- `WorkflowNode.agentId` shorthand removed from all editor/card components — `agents[]` used instead.
- Deprecated fields removed from UI.
- All frontend tests pass.

**Dependencies:** Task 1, Task 3

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 11: Workflow manager validation and RPC handlers

**Description:** Add `endNodeId` validation, update RPC handlers for new schema.

**Agent type:** coder

**Subtasks:**

1. **Workflow manager validation** (`space-workflow-manager.ts`):
   - Validate `endNodeId` references a valid node on create/update.
   - Remove validation of deprecated fields.
2. **RPC handler updates:**
   - **Verification:** Confirm `spaceWorkflow.create` and `spaceWorkflow.update` handlers pass `endNodeId` through (current handlers use cast/spread — no whitelist).
   - **`space-workflow-run-handlers.ts`:** Update all 19 hardcoded `'needs_attention'` references to `'blocked'`. Update `'completed'` to `'done'`. The `markFailed` handler assigns `needs_attention` as a transition target — this will break the CHECK constraint if not updated. Remove references to `goalId`, `config` params. **Keep `failureReason`** references as-is (gate rejection flow preserved).
   - **`space-task-message-handlers.ts`:** Update references to removed task fields (`workflowNodeId`, `agentName`) used for routing. Note: `taskAgentSessionId` is **kept** — the handlers' usage of it for orchestration task session management is correct and should remain.
   - Remove references to `goalId`, `config` from all run-related handlers.
   - **`space-agent-handlers.ts`:** Verify `spaceAgent.create` and `spaceAgent.update` handlers pass through the new `instructions` field. Since these handlers likely use a cast/spread pattern (like `spaceWorkflow`), confirm `instructions` is not silently dropped. Add explicit passthrough if needed.
3. **`nodeExecution.list` RPC handler (required):**
   - Add `nodeExecution.list` RPC handler that returns `NodeExecution[]` filtered by `workflowRunId`. This is **mandatory** — the frontend canvas (`WorkflowCanvas.tsx`, `VisualWorkflowEditor.tsx`) needs per-node execution data to display node status after `workflowNodeId` is removed from `space_tasks`.
   - Add corresponding LiveQuery named query (`nodeExecutions.byRun`) for reactive frontend updates.
4. **Tool file updates:**
   - **`space-agent-tools.ts`:** grep for all `completed`, `needs_attention` status references and update (`completed` → `done`, `needs_attention` → `blocked`, etc.). Replace `taskRepo.listByWorkflowRun(run.id)` calls (lines ~142, ~308 in `get_workflow_run` and `change_plan`) with `nodeExecutionRepo.listByWorkflowRun(run.id)` — update the response shape from `{ run, tasks }` to `{ run, executions }` (see subtask 6 below for output contract).
   - **`global-spaces-tools.ts`:** grep for all old status value references and update similarly. Remove references to `goalId`, `taskType`, `assignedAgent`. Replace `taskRepo.listByWorkflowRun()` calls (lines ~255, ~272) with `nodeExecutionRepo.listByWorkflowRun()`.
   - **`neo-query-tools.ts`:** Remove references to `taskType`, `assignedAgent` (14 occurrences), `completionSummary`, `progress`, and other removed fields in display logic.
   - **`neo-action-tools.ts`:** Update all `needs_attention` references → `blocked`, all `completed` references → `done` (grep for exact counts — distributed across status checks, gate handlers, and Zod enums). **Keep `failureReason`** references as-is (gate rejection flow preserved). Update the `set_task_status` `z.enum` (lines ~2204–2214) from the 8 old `SpaceTaskStatus` values (`draft`, `pending`, `in_progress`, `review`, `completed`, `needs_attention`, `cancelled`, `archived`) to the 6 new values (`open`, `in_progress`, `done`, `blocked`, `cancelled`, `archived`); update description strings accordingly. Confirm `set_goal_status` `z.enum` at line ~2125 (`['active', 'completed', 'needs_human', 'archived']`) is room-level `GoalStatus` — out of scope, do not change.
   - **`provision-global-agent.ts`** and **`reference-resolver.ts`:** Verify and update any usage of removed `SpaceTask` fields.
6. **`get_workflow_run` output contract (post-migration):**
   - Today `get_workflow_run` in `space-agent-tools.ts` returns `{ run, tasks }` where `tasks` is `SpaceTask[]` from `listByWorkflowRun`. After migration, workflow-node execution state lives in `node_executions`. The new response shape is `{ run, executions }` where `executions` is `NodeExecution[]` from `nodeExecutionRepo.listByWorkflowRun()`. The Task Agent system prompt (Task 6 subtask 4) must document this change so the agent knows execution status is in `executions`, not `tasks`.
   - `global-spaces-tools.ts` `get_workflow_run` follows the same pattern.
7. **Tests:**
   - Validation tests: valid/invalid `endNodeId`, `null` to clear.
   - RPC passthrough regression test for `spaceWorkflow.create` with `endNodeId`.
   - `nodeExecution.list` handler test: returns correct executions for a given run.

**Acceptance criteria:**
- `endNodeId` validated at create/update.
- RPC handlers updated for new schema — no references to old status values or removed fields.
- `nodeExecution.list` RPC handler exists and is functional.
- All tool files use new status values.
- All tests pass.

**Dependencies:** Task 1, Task 3

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 12: Integration tests

**Description:** End-to-end integration tests for the complete end-node completion flow and schema cleanup.

**Agent type:** coder

**Subtasks:**

1. **Extend** `space-runtime-completion.test.ts` with new integration scenarios:
   - Workflow with `endNodeId`: end node execution `done` → `processRunTick` → run `done`.
   - Non-end node completes but end node still running → run stays `in_progress`.
   - Workflow without `endNodeId` → all-executions-done behavior (backward compat).
   - `WorkflowNodeAgent.systemPrompt = { mode: 'override', value: 'X' }` → composed system prompt equals `'X'` (agent's base `systemPrompt` is discarded).
   - `WorkflowNodeAgent.systemPrompt = { mode: 'expand', value: 'X' }` → composed system prompt equals `agent.systemPrompt + '\n\nX'`.
   - Same two scenarios for `instructions`.
   - `WorkflowNodeAgent` with no `systemPrompt`/`instructions` → composed values equal agent base values (no-override passthrough).
   - End node execution `blocked` → run escalates to `blocked`.
   - End node `done` while sibling nodes still `blocked` → run completes (end-node bypass fires, siblings cancelled). This exercises the specific guard from Task 5.2 where end-node completion takes priority over sibling `blocked` status.
   - End node execution not yet created → run stays `in_progress`.
   - Orchestration task auto-completed when run completes (if `in_progress`).
   - Orchestration task in `open` state at completion → skipped, no throw.
2. Verify no existing integration tests rely on `report_workflow_done`.
3. Verify `NodeExecution` creation/completion flow works end-to-end through runtime.
4. **Update online space tests** that assert against old status values:
   - `space-happy-path-full-pipeline.test.ts`: update `run.status === 'completed'` → `'done'`, `waitForRunStatus(…, ['completed'])` → `['done']`.
   - `space-happy-path-plan-to-approve.test.ts`: update `'needs_attention'` → `'blocked'`.
   - `space-happy-path-code-review.test.ts`: update `'completed'` → `'done'`.
   - `space-happy-path-qa-completion.test.ts`, `space-edge-cases.test.ts`, `space-agent-coordination.test.ts`, `task-agent-lifecycle.test.ts`, `task-agent-skills.test.ts`, `space-chat-session.test.ts`: update old status references.
   - `helpers/space-test-helpers.ts`: update `waitForRunStatus`, `waitForNodeActivated` helpers for new status values.

**Acceptance criteria:**
- Full lifecycle proven: node `report_done` → execution `done` → tick → run `done`.
- Backward compat: workflows without `endNodeId` still complete.
- Schema cleanup doesn't break any existing test patterns.
- All online space tests updated and passing with new status values.

**Dependencies:** Task 4, Task 5, Task 6, Task 11

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 13: Frontend status/field migration (comprehensive)

**Description:** Update all frontend files that reference old `SpaceTaskStatus` values, removed `SpaceTask` fields, removed `SpaceAgent` fields, and old `WorkflowRunStatus` values. This is a sweeping cleanup task covering 67+ files with 547+ occurrences of old values. Separate from Task 10 (which handles workflow editor-specific changes) — this task covers all other frontend components, stores, hooks, and constants.

**Agent type:** coder

**Subtasks:**

1. **Status constants and colors** (`packages/web/src/lib/task-constants.ts`):
   - Update `TASK_STATUS_COLORS`: replace `pending` → `open`, `completed` → `done`, `needs_attention` → `blocked`, `review` → remove (or map to `in_progress`), `draft` → `open`, `rate_limited` → `blocked`, `usage_limited` → `blocked`.
   - **`ROLE_COLORS` — keep for room conversation rendering.** `ROLE_COLORS` (in `task-constants.ts` and the separate `packages/web/src/lib/role-colors.ts`) maps `authorRole` strings (`'planner'`, `'coder'`, `'leader'`, `'human'`, etc.) for conversation turn color-coding in `TaskConversationRenderer.tsx`, `TurnSummaryBlock.tsx`, `useTurnBlocks.ts`, `SlideOutPanel.tsx`, `AgentTurnBlock.tsx`. These `authorRole` values come from session metadata (`group_member.role`), **not** from `SpaceAgent.role`. Removing `ROLE_COLORS` would break room conversation rendering. Only remove space-specific `SpaceAgent.role`-keyed display (e.g., `RoleBadge` in `SpaceAgentList.tsx` line 48).
   - Update any status label/icon mappings.

2. **Space store** (`packages/web/src/lib/space-store.ts`):
   - Replace `tasksByNodeId` computed signal (lines 128–135) with `nodeExecutionsByNodeId` — this must query `NodeExecution` data (via the new `nodeExecution.list` LiveQuery from Task 11) instead of filtering `SpaceTask.workflowNodeId`.
   - Update all old status value references throughout the file.

3. **Room store** (`packages/web/src/lib/room-store.ts`):
   - Update 12 occurrences of old status values.

4. **Space dashboard and pane components:**
   - `SpaceDashboard.tsx`: update old status checks.
   - `SpaceTaskPane.tsx`: update status-dependent rendering, remove references to removed fields (`completionSummary`, `progress`, `currentStep`). Note: `prUrl`, `prNumber`, `inputDraft` do not exist in this file; `taskAgentSessionId` is kept.
   - `SpaceContextPanel.tsx` (line 34): update `case 'needs_attention':` → `case 'blocked':`.
   - `SpaceDetailPanel.tsx`: update old status references.

5. **Workflow canvas** (`WorkflowCanvas.tsx`):
   - Update `NodeStatus` type (line 53): replace `'completed'` → `'done'`, `'failed'` → `'cancelled'` or remove.
   - Line 771: update `tasksByNodeId.get(nodeId)` → `nodeExecutionsByNodeId.get(nodeId)`.
   - Line 1141: update `run.status === 'needs_attention'` → `run.status === 'blocked'`.
   - `isNodeFullyCompleted()`: update status checks to use `NodeExecutionStatus`.

6. **Task views and hooks:**
   - `RoomTasks.tsx`: update 40 occurrences of old status/field references.
   - `TaskView.tsx`, `TaskViewV2.tsx`: update old `SpaceTaskStatus` values. Note: these components primarily operate on room-level `NeoTask` — do NOT remove `prUrl`, `prNumber`, `inputDraft` (room-level fields, out of scope). Only remove references to `SpaceTask`-specific removed fields (`completionSummary`, `progress`, `currentStep`) if they appear in space-task rendering paths.
   - `TaskActionDialogs.tsx`: update status-dependent actions.
   - `TaskReviewBar.tsx`: **out of scope** — this component operates on room-level `NeoTask` (from `neo.ts`) and uses `task.prUrl`/`task.prNumber`, which are room-level fields. It is used in `TaskViewV2.tsx` for room-level PR review. Since room-level `TaskStatus` is explicitly out of scope (see Scope Notes), this component does not need changes in this migration.
   - `HeaderReviewBar.tsx`: update review status references.
   - `useTaskViewData.ts`: remove references to removed `SpaceTask` fields.
   - `useTaskInputDraft.ts`: **out of scope** — this hook operates on room-level `NeoTask` (calls `task.get` with `roomId`, reads `response.task?.inputDraft`), not `SpaceTask`. The `inputDraft` being removed is from `SpaceTask`; room-level `NeoTask.inputDraft` is unchanged.

7. **Island components:**
   - `RoomContextPanel.tsx`: update old status references.

8. **Tests:**
   - Update all affected frontend test files for new status values and removed fields.
   - Run `bun run typecheck` to verify no remaining references to old types.

**Acceptance criteria:**
- Zero references to old `SpaceTaskStatus` values (`draft`, `pending`, `completed`, `review`, `needs_attention`, `rate_limited`, `usage_limited`) in frontend code.
- Zero references to removed `SpaceTask` fields (`workflowNodeId`, `agentName`, `customAgentId`, `taskType`, `goalId`, `error`, `assignedAgent`, `inputDraft`, `progress`, `currentStep`, `completionSummary`) in frontend code. Note: `taskAgentSessionId`, `workflowRunId`, `prUrl`, `prNumber`, `prCreatedAt`, `activeSession`, `createdByTaskId` are **kept** — do not remove references to these.
- Zero references to `SpaceAgent.role` in space-specific frontend code (e.g., `SpaceAgentList.tsx` `RoleBadge`, `NodeConfigPanel` role display, `visual-editor/WorkflowCanvas.tsx` `agentRoleToNodeId`). Note: `ROLE_COLORS` for room conversation rendering is **kept** — it uses `authorRole` from session metadata, not `SpaceAgent.role`.
- `tasksByNodeId` replaced with `nodeExecutionsByNodeId` backed by `NodeExecution` data.
- `bun run typecheck` passes.
- `bunx vitest run` passes.

**Dependencies:** Task 1, Task 3, Task 11 (for `nodeExecution.list` LiveQuery)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Dependency Graph

```
Task 1 (types)
├── Task 2 (migrations) → Task 3 (repositories) → Task 4 (managers/CompletionDetector)
│                                                  → Task 5 (runtime) → Task 6 (agent tools)
│                                                  → Task 7 (agent/utility cleanup) → Task 8 (templates)
│                                                  → Task 9 (export/import)
│                                                  → Task 10 (frontend editors)
│                                                  → Task 11 (validation/RPC) → Task 13 (frontend status migration)
│                                                  └── Task 12 (integration tests) ← Tasks 4,5,6,11
```

Parallelizable after Task 3: Tasks 7, 9, 10 can run concurrently. Tasks 4, 5 are sequential. Task 6 depends on 4+5. Task 8 depends on 7. Task 11 can run after Task 3. Task 13 depends on Tasks 1, 3, and 11 (needs `nodeExecution.list` LiveQuery). Task 12 depends on 4+5+6+11.

## Scope Notes

### Room-level `TaskStatus` is out of scope

The room-level `TaskStatus` type (in `packages/shared/src/types/neo.ts`) uses the same 10 old values as `SpaceTaskStatus`. Files like `task-handlers.ts`, `room-agent-tools.ts`, `goal-manager.ts`, and `room-manager.ts` all use room-level `TaskStatus`. **This is intentionally out of scope** — room tasks and space tasks are separate systems. The two type systems will temporarily diverge after this migration. Unifying them is a separate effort.

### Cross-task file split: `VisualWorkflowEditor.tsx`

Task 10 modifies `VisualWorkflowEditor.tsx` for `endNodeId` and `agents[]` changes. Task 13 replaces `tasksByNodeId` with `nodeExecutionsByNodeId` in the same file. To avoid an intermediate compile error, Task 10 subtask 2 adds a temporary `computed(() => new Map())` shim for `tasksByNodeId`, which Task 13 then replaces with the real `nodeExecutionsByNodeId` signal.

### Line numbers are approximate

Line numbers referenced throughout this plan (e.g., "line ~455", "lines ~2204–2214") are based on the codebase at plan-writing time and will drift as concurrent changes land. Implementors should verify line numbers at implementation time using grep/search rather than relying on specific numbers.

# Milestone 5: Per-Slot Agent Overrides in Nodes

## Goal

Allow adding the same agent definition multiple times to a single workflow node, differentiated by per-slot configuration overrides (`role`, `model`, `systemPrompt`). The agent editor remains the base config/defaults; node slot overrides are local to that workflow node.

## Scope

- Extend `WorkflowNodeAgent` with `role`, `model?`, `systemPrompt?` fields
- Remove the restriction blocking duplicate `agentId` values within a node
- Agent editor remains the base config / defaults source
- Backend resolves final config as base + overrides at runtime
- UI clearly displays when overrides are active
- Update export/import format for the new fields

## Tasks

### Task 5.1: Extend WorkflowNodeAgent schema with override fields

**Description:** Add `role`, `model?`, and `systemPrompt?` fields to `WorkflowNodeAgent` (and `WorkflowNodeInput`). Update the export format type. Ensure `role` is required and unique within a node.

**Subtasks:**
1. Run `bun install` at worktree root.
2. In `packages/shared/src/types/space.ts`:
   - Add to `WorkflowNodeAgent`:
     ```
     role: string;          // unique within the node, e.g. "strict-reviewer"
     model?: string;        // override the agent's default model
     systemPrompt?: string; // override the agent's default system prompt
     ```
   - Add same fields to `WorkflowNodeInput` (with `role` required)
   - Add to `ExportedWorkflowNodeAgent`: `role`, `model?`, `systemPrompt?`
3. In `packages/shared/src/types/space-utils.ts`:
   - Update `resolveStepAgents` (now `resolveNodeAgents`) to use the new `role` field
   - Add validation: `role` must be unique within a node's agent list
   - Remove validation that blocks duplicate `agentId` values (if any)
4. Update shared package tests.
5. Run `bun run typecheck`.

**Acceptance Criteria:**
- `WorkflowNodeAgent` has `role`, `model?`, `systemPrompt?` fields
- `role` is required and validated as unique within a node
- Same `agentId` can appear multiple times if `role` is different
- Shared types compile cleanly
- **Note:** Backward compatibility for existing data without `role` is not required — this feature is not yet in production

**Dependencies:** Milestone 2 (types are `WorkflowNodeAgent`)

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5.2: Update backend to resolve base + override config at runtime

**Description:** Update the workflow executor and agent initialization to merge base agent config with per-slot overrides when spawning agent sessions.

**Subtasks:**
1. Run `bun install` at worktree root.
2. In `packages/daemon/src/lib/agents/custom-agent.ts`:
   - Update `resolveAgentInit` to accept optional `model` and `systemPrompt` overrides
   - When overrides are provided, merge them with the base agent config:
     - `model` override replaces agent's default model
     - `systemPrompt` override replaces (or appends to) the agent's default system prompt
   - Use the slot's `role` field as the agent's role in the session group (instead of the base agent's role)
3. In `packages/daemon/src/lib/space/runtime/workflow-executor.ts`:
   - When spawning agents for a multi-agent node, pass the per-slot overrides to `resolveAgentInit`
   - Use the slot's `role` for session group membership
4. In `packages/daemon/src/lib/space/runtime/space-runtime.ts`:
   - Update channel resolution to use slot `role` values (not base agent roles)
5. In `packages/daemon/src/storage/repositories/space-workflow-repository.ts`:
   - Ensure the new fields are persisted in the `agents` JSON column
6. Run `bun run typecheck` and `bun run lint`.
7. Write unit tests:
   - Test that model override is applied when spawning agent session
   - Test that systemPrompt override is applied
   - Test that slot role is used for channel resolution
   - Test multiple instances of same agent with different roles

**Acceptance Criteria:**
- Agent sessions spawned with resolved config (base + overrides)
- Slot `role` used for session group membership and channel resolution
- Overrides persisted correctly in DB
- Unit tests cover all override scenarios

**Dependencies:** Task 5.1

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5.3: Update UI for per-slot agent overrides

**Description:** Update the visual editor's NodeConfigPanel and the list-view WorkflowNodeCard to support per-slot agent overrides. Display override indicators clearly to avoid hidden behavior surprises.

**Subtasks:**
1. Run `bun install` at worktree root.
2. In `packages/web/src/components/space/visual-editor/NodeConfigPanel.tsx`:
   - Show per-agent-slot configuration section for each agent in the node
   - Allow editing `role` (required, text input)
   - Allow optional `model` override (model selector dropdown or text input)
   - Allow optional `systemPrompt` override (textarea)
   - Show visual indicator when an override is active (e.g., badge, different background color)
   - Allow adding the same agent multiple times (remove duplicate-agent restriction in the "Add Agent" UI)
3. In `packages/web/src/components/space/WorkflowNodeCard.tsx` (list view):
   - Display slot role names alongside agent names
   - Show override indicators (small icon or text like "custom model", "custom prompt")
4. In `packages/web/src/components/space/visual-editor/WorkflowNode.tsx` (canvas node):
   - Show slot count or role names when multiple agents are present
   - Indicate overrides with a visual cue
5. Update `packages/web/src/components/space/visual-editor/serialization.ts`:
   - Serialize/deserialize the new fields
6. Run `bun run typecheck` and `bun run lint`.
7. Write component tests:
   - Test adding same agent twice with different roles
   - Test override fields display and editing
   - Test serialization round-trip with overrides

**Acceptance Criteria:**
- Users can add the same agent multiple times to a node with different roles
- Override fields (model, systemPrompt) are editable per slot
- Active overrides are visually indicated
- Serialization handles new fields correctly

**Dependencies:** Task 5.1, Task 5.2

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5.4: Update export/import and tests for per-slot overrides

**Description:** Update the export/import format to include per-slot override fields. Add comprehensive tests.

**Subtasks:**
1. Run `bun install` at worktree root.
2. In `packages/daemon/src/lib/space/export-format.ts`:
   - Include `role`, `model`, `systemPrompt` in `ExportedWorkflowNodeAgent` serialization
   - On import, map these fields back to `WorkflowNodeAgent`
3. In `packages/daemon/src/lib/rpc-handlers/space-export-import-handlers.ts`:
   - Ensure the new fields pass through the export/import pipeline
4. Update `packages/daemon/tests/unit/space/export-format.test.ts`:
   - Test export with per-slot overrides
   - Test import with per-slot overrides
   - Test backward compatibility (import without override fields)
5. Add integration test: full round-trip export -> import with overrides
6. Update e2e test `packages/e2e/tests/features/space-export-import.e2e.ts` if applicable.
7. Run all affected tests.

**Acceptance Criteria:**
- Export/import handles per-slot override fields correctly
- Backward compatible: old exports without override fields import cleanly
- Tests cover all scenarios

**Dependencies:** Task 5.3 (must complete first to ensure frontend serialization field names are settled before backend export/import is updated)

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

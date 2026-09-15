# Unify Agent Communication & Workflow Graph Model

## Goal

Refactor the space workflow system to treat all agents -- including the Task Agent -- as equal first-class participants in a unified graph model. Remove special-cased messaging tools and terminology in favor of a consistent, intuitive model.

## High-Level Approach

The six changes are interdependent and will be delivered in a carefully sequenced order to minimize intermediate breakage:

1. **Rename first** (`send_feedback` -> `send_message`, `step` -> `node`) -- pure mechanical renames that touch many files but have no behavioral change.
2. **Unify messaging** -- remove `relay_message` and `request_peer_input`, give everyone `send_message` with channel topology enforcement. Task Agent becomes a regular channel participant.
3. **Task Agent as visible node** -- render in the visual editor, auto-create channels on new node addition.
4. **Per-slot agent overrides** -- extend `WorkflowNodeAgent` with `role`, `model`, `systemPrompt` fields; allow duplicate agents per node.
5. **Channel direction visualization** -- render arrowheads on canvas edges for bidirectional vs unidirectional channels.

## Milestones

1. **Rename `send_feedback` to `send_message`** -- Rename the tool across schemas, handlers, tests, and system prompts. Pure rename, no behavioral change.
2. **Rename `WorkflowStep` to `WorkflowNode`** -- Rename types, DB columns (via migration), repositories, runtime, UI components, export/import format, and all tests. Pure rename, no behavioral change.
3. **Unified messaging model** -- Remove `relay_message` and `request_peer_input`. All agents (Task Agent + node agents) use `send_message` with uniform channel topology enforcement. Task Agent gets default channels to all nodes.
4. **Task Agent as a first-class visible node** -- Render Task Agent as a pinned node in the visual editor. Auto-create default bidirectional channels between Task Agent and new nodes. Channels are removable by user.
5. **Per-slot agent overrides in nodes** -- Allow adding the same agent multiple times to a node with per-slot `role`, `model`, and `systemPrompt` overrides. Update schema, runtime resolution, UI, and tests.
6. **Channel direction visualization** -- Render bidirectional vs unidirectional channel direction as arrowheads on canvas edges. Update `EdgeRenderer.tsx` and `WorkflowCanvas.tsx`.

## Cross-Milestone Dependencies

- Milestone 2 (step->node rename) has no behavioral dependency on Milestone 1 but both are pure renames so they can run in parallel.
- Milestone 3 (unified messaging) depends on Milestone 1 (the tool is already called `send_message`).
- Milestone 4 (Task Agent visible node) depends on Milestone 2 (types are already `WorkflowNode`) and Milestone 3 (Task Agent uses same messaging).
- Milestone 5 (per-slot overrides) depends on Milestone 2 (types are `WorkflowNodeAgent`).
- Milestone 6 (direction visualization) depends on Milestone 4 (Task Agent channels rendered as edges).

## Key Sequencing

```
M1 (rename send_feedback)  ---> M3 (unified messaging) ---> M4 (Task Agent visible node) ---> M6 (direction viz)
M2 (rename step->node)     ---> M4 (Task Agent visible node)
M2 (rename step->node)     ---> M5 (per-slot overrides)
```

Milestones 1 and 2 can proceed in parallel. Milestones 5 and 6 can also proceed in parallel after their respective dependencies.

## Total Estimated Task Count

~23 tasks across 6 milestones (Task 1.3 collapsed into Task 1.1).

## Important Context

- **No backward compatibility required**: This feature is not yet in production. No migration paths or fallback strategies are needed for existing data.
- **DB migrations must use the create-copy-drop-rename pattern** (NOT `ALTER TABLE RENAME COLUMN`) — consistent with all existing migrations in the project.
- **Channel direction type values** are `'one-way' | 'bidirectional'` (NOT `'unidirectional'`) — see `packages/shared/src/types/space.ts`.

## Key Files (by area)

### Shared Types
- `packages/shared/src/types/space.ts` -- `WorkflowStep`, `WorkflowStepAgent`, `WorkflowStepInput`, `ExportedWorkflowStep`, `WorkflowChannel`
- `packages/shared/src/types/space-utils.ts` -- utility functions for step/agent resolution

### Backend Tools & Runtime
- `packages/daemon/src/lib/space/tools/step-agent-tools.ts` -- `send_feedback`, `request_peer_input` handlers
- `packages/daemon/src/lib/space/tools/step-agent-tool-schemas.ts` -- Zod schemas
- `packages/daemon/src/lib/space/tools/task-agent-tools.ts` -- `relay_message` handler
- `packages/daemon/src/lib/space/tools/task-agent-tool-schemas.ts` -- Zod schemas
- `packages/daemon/src/lib/space/runtime/channel-resolver.ts` -- channel topology validation
- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- wires step agent tools
- `packages/daemon/src/lib/agents/custom-agent.ts` -- agent initialization
- `packages/daemon/src/lib/space/agents/task-agent.ts` -- Task Agent system prompt, step references

### Backend Storage
- `packages/daemon/src/storage/schema/migrations.ts` -- `space_workflow_steps` table, `start_step_id` column
- `packages/daemon/src/storage/repositories/space-workflow-repository.ts` -- CRUD for steps

### Frontend Components
- `packages/web/src/components/space/visual-editor/` -- entire visual editor directory
- `packages/web/src/components/space/WorkflowStepCard.tsx` -- step card component
- `packages/web/src/components/space/WorkflowEditor.tsx` -- workflow editor
- `packages/web/src/components/space/WorkflowRulesEditor.tsx` -- rules editor

### Tests
- `packages/daemon/tests/unit/space/` -- ~15 test files affected
- `packages/web/src/components/space/__tests__/` -- step card, editor, rules tests
- `packages/web/src/components/space/visual-editor/__tests__/` -- visual editor tests
- `packages/e2e/tests/features/` -- 5 space-related e2e test files

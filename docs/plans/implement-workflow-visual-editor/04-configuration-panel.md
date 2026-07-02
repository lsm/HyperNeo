# Milestone 4: Node Configuration Panel

## Goal

Build a side panel that appears when a node or edge is selected, allowing users to edit its properties without leaving the visual editor.

## Tasks

### Task 4.1: Create NodeConfigPanel component

**Description**: Build a slide-in side panel (right side, ~320px wide) that displays when a node is selected. The panel reuses the same field layout as the existing `WorkflowStepCard` expanded view: step name, agent dropdown, instructions textarea, entry/exit gate selectors.

**Agent type**: coder

**Subtasks**:
1. Create `packages/web/src/components/space/visual-editor/NodeConfigPanel.tsx`:
   - Props: `step` (StepDraft), `agents` (SpaceAgent[]), `entryCondition`, `exitCondition`, `isStartNode`, `onUpdate`, `onUpdateEntryCondition`, `onUpdateExitCondition`, `onSetAsStart`, `onClose`, `onDelete`
   - Render a right-anchored panel with header (step name + close button) and scrollable body
   - Fields: Step Name input, Agent dropdown, Entry Gate selector (reuse `GateConfig` pattern from WorkflowStepCard), Exit Gate selector, Instructions textarea
   - **"Set as Start" button**: Prominently placed below the step name. When clicked, calls `onSetAsStart(stepId)` which updates `startStepId` in the parent state. Button is disabled/hidden when the node is already the start node. This is the explicit, primary mechanism for designating the start node — no heuristic-based detection.
   - Delete Step button at bottom with confirmation (disabled for start node — user must designate another start node first)
2. Extract the `GateConfig` sub-component from `WorkflowStepCard.tsx` into a shared file `packages/web/src/components/space/visual-editor/GateConfig.tsx` so both the old editor and the visual editor can use it
3. Style consistent with HyperNeo dark theme; panel animates in from right
4. Add tests: renders all fields, updates propagate on change, delete triggers confirmation, "Set as Start" button works and is disabled for current start node

**Acceptance criteria**:
- Panel appears when a node is selected, disappears on close or deselect
- All step properties can be edited inline
- "Set as Start" button correctly designates the selected node as start node
- Start node cannot be deleted until another node is designated as start
- Gate condition type changes work (always, human, condition with expression)
- Delete step works with confirmation
- Tests pass

**Dependencies**: Task 2.3

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 4.2: Create EdgeConfigPanel component

**Description**: When an edge (transition) is selected, show a simpler config panel for editing the transition's condition type and expression.

**Agent type**: coder

**Subtasks**:
1. Create `packages/web/src/components/space/visual-editor/EdgeConfigPanel.tsx`:
   - Props: `transition` (with from/to step names, condition), `onUpdateCondition`, `onDelete`, `onClose`
   - Show source and target step names (read-only)
   - Condition type selector (always, human, condition) with expression input for condition type
   - Delete transition button
2. Add tests: renders from/to names, condition editing works, delete triggers callback

**Acceptance criteria**:
- Panel shows when edge is selected
- Condition type and expression can be edited
- Delete removes the transition
- Tests pass

**Dependencies**: Task 4.1 (shared panel layout patterns)

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

# Milestone 2: Node Rendering and Drag-and-Drop

## Goal

Render workflow steps as draggable node cards on the canvas, with visual connection ports for creating edges.

## Tasks

### Task 2.1: Create WorkflowNode component

**Description**: Build a `WorkflowNode` component that renders a single workflow step as a card on the canvas. The card shows the step name, assigned agent name, and a step number badge. It has an input port (top center) and output port (bottom center) for connections. The node is absolutely positioned on the canvas using its stored coordinates.

**Agent type**: coder

**Subtasks**:
1. Create `packages/web/src/components/space/visual-editor/WorkflowNode.tsx`:
   - Props: `step` (StepDraft), `position` (Point), `agents` (SpaceAgent[]), `isSelected`, `isStartNode`, connection port event handlers
   - Render a card with: step number badge (top-left), step name, agent name (resolved from agents list), selection highlight border
   - Start node gets a green border (`border-green-500`) and a "START" badge (top-right) for clear visual distinction
   - Render input port (small circle, top-center, hidden on start node) and output port (small circle, bottom-center)
   - Port circles emit `onPortMouseDown(stepId, 'input'|'output')` for connection creation
   - Apply `cursor: grab` and selection ring (`ring-2 ring-blue-500`) when selected
2. Style to match existing HyperNeo dark theme, consistent with `WorkflowStepCard` visual language
3. Add unit tests: renders step name, shows agent name, applies selected style, renders ports, start node shows START badge and green border

**Acceptance criteria**:
- Node renders step name and agent name correctly
- Input and output ports are visible and emit mouse events
- Selected state shows visual distinction
- Start node hides input port
- Tests pass

**Dependencies**: Task 1.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 2.2: Implement node drag-and-drop

**Description**: Make `WorkflowNode` draggable on the canvas. Dragging updates the node's position in the parent state. Must account for canvas viewport transform (pan/zoom) when converting mouse deltas to canvas coordinates.

**Agent type**: coder

**Subtasks**:
1. Add drag handling to `WorkflowNode`: `onMouseDown` on the card body (not ports) starts drag, `onMouseMove` on window updates position, `onMouseUp` on window ends drag
2. During drag, compute delta in canvas coordinates using viewport scale: `deltaCanvas = deltaScreen / scale`
3. Emit `onPositionChange(stepId, newPosition)` to parent
4. Add visual feedback: `cursor: grabbing` during drag, slight shadow elevation
5. Prevent drag from triggering on port clicks (stopPropagation on port mousedown)
6. Add tests: position updates on drag, drag respects viewport scale

**Acceptance criteria**:
- Nodes can be dragged freely on the canvas
- Position updates correctly accounting for zoom level
- Dragging does not interfere with port click events
- Dragging does not trigger canvas pan
- Tests pass

**Dependencies**: Task 2.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 2.3: Node selection and multi-select

**Description**: Implement node selection. Clicking a node selects it (and deselects others). Clicking canvas background deselects all. Selection state drives the configuration panel (Milestone 4).

**Agent type**: coder

**Subtasks**:
1. Add `selectedNodeId` state management: click node sets it, click canvas background clears it
2. Pass `isSelected` prop to `WorkflowNode` based on `selectedNodeId`
3. Add keyboard support: Delete/Backspace on selected node triggers `onDeleteNode`
4. Emit `onNodeSelect(stepId | null)` callback for parent component
5. Add tests: click selects, click background deselects, delete key triggers removal

**Acceptance criteria**:
- Single-click selects a node with visual indicator
- Clicking canvas deselects
- Delete key removes selected node
- Selection state is accessible to parent components
- Tests pass

**Dependencies**: Task 2.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

# Milestone 6: Frontend — Agent & Workflow UI

## Goal

Build the UI for creating/editing custom agents and the visual workflow builder within the Space interface. These integrate into the 3-column layout from M5.

## Scope

- Custom agent list, detail, and editor components
- Workflow list, visual step builder, and rules editor
- Integration into Space layout (middle column views)
- E2E tests

---

### Task 6.1: Custom Agent List and Editor

**Agent:** coder
**Priority:** high
**Depends on:** Task 2.2, Task 5.3

**Description:**

Build the UI for listing, creating, and editing custom agents within a Space.

**Subtasks:**

1. Create `packages/web/src/components/space/SpaceAgentList.tsx`:
   - Displays agents as compact cards: name, role badge, model, description preview
   - "Create Agent" button
   - Click to open editor
   - Subscribes to `spaceAgent.created/updated/deleted` events via SpaceStore
   - Empty state: "No custom agents yet. Create one to get started."

2. Create `packages/web/src/components/space/SpaceAgentEditor.tsx`:
   - Form fields:
     - **Name**: text input (required, unique within space)
     - **Description**: textarea
     - **Role**: radio buttons (`worker`, `reviewer`, `orchestrator`) with tooltips
     - **Model**: model picker (reuse existing `ModelPicker` patterns)
     - **Provider**: auto-detected from model or manual override
     - **Tools**: multi-select checklist from `KNOWN_TOOLS` constant (single source of truth from `@hyperneo/shared`)
     - **System Prompt**: monospace textarea with line numbers
   - Tool presets: "Full Coding" (all), "Read Only" (Read, Grep, Glob), "Custom"
   - System prompt templates: "Coder", "Reviewer", "Research", "Custom (blank)"
   - Save/Cancel buttons with loading states and error toasts
   - Form validation: name required + unique, model required, at least one tool

3. Delete confirmation with workflow reference warning:
   - "This agent is used in X workflows. Remove it from those workflows first."

4. Write unit tests:
   - Agent list renders with mock data and handles empty state
   - Editor form validates correctly
   - Tool presets work
   - Tool list populated from `KNOWN_TOOLS`
   - Delete shows warning when referenced

**Acceptance criteria:**
- Full agent CRUD flow works in the Space UI
- Tool selection uses shared `KNOWN_TOOLS` constant
- System prompt templates provide starting points
- Deletion blocked with clear message when referenced by workflows
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 6.2: Workflow Step Builder

**Agent:** coder
**Priority:** high
**Depends on:** Task 3.3, Task 5.3

**Description:**

Build the visual workflow editor for composing agent steps with transitions and conditions.

**Subtasks:**

1. Create `packages/web/src/components/space/WorkflowList.tsx`:
   - Workflow cards: name, description, step count, tag chips
   - "Create Workflow" button
   - Real-time updates via SpaceStore
   - Mini step visualization (horizontal dots/icons showing the step sequence)
   - **No "default badge" or "Set as Default" action** — there is no default workflow concept

2. Create `packages/web/src/components/space/WorkflowEditor.tsx`:
   - Workflow name and description fields at top
   - Vertical step list in center (expandable step cards)
   - "Add Step" button at bottom
   - Save/Cancel buttons
   - "Start from template" option for new workflows:
     - "Coding (Plan → Code)", "Research (Plan → Research)", "Quick Fix (Code only)"
     - Templates populate steps and transitions with sensible defaults

3. Create `packages/web/src/components/space/WorkflowStepCard.tsx`:
   - Collapsed: step number, agent name, outgoing transition condition indicator
   - Expanded: full configuration
   - Fields:
     - **Name**: text input
     - **Agent**: dropdown of all `SpaceAgent` records in the space (preset roles + custom agents)
     - **Instructions**: textarea for step-specific context
   - Transition editor (below each step card):
     - Add/remove outgoing transitions to other steps
     - Condition type selector: `always`, `human`, `condition`
     - For `condition` type: shell expression text input + optional timeout
   - Up/down reorder buttons (drag-and-drop as future enhancement)
   - Remove step button

4. Write unit tests:
   - Step adding, removal, reordering
   - Agent dropdown shows all SpaceAgent records
   - Transition condition forms render correctly for each condition type
   - Template selection populates steps and transitions

**Acceptance criteria:**
- Visual workflow builder allows multi-step composition with transitions
- Steps can be added, removed, reordered
- Agent selection shows all SpaceAgent records in the space
- Transition conditions can be configured per-transition
- Templates provide quick starts
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 6.3: Workflow Rules Editor and Integration

**Agent:** coder
**Priority:** normal
**Depends on:** Task 6.2

**Description:**

Add the rules editor to the workflow builder, tags editor, and integrate all agent/workflow UI into the Space layout.

**Subtasks:**

1. Create `packages/web/src/components/space/WorkflowRulesEditor.tsx`:
   - Rule list with name and content preview
   - "Add Rule" button
   - Each rule:
     - Name input
     - Content textarea (Markdown-friendly)
     - "Applies to" multi-select showing step display names but storing step **IDs** (IDs survive renames; empty = all steps)
     - Remove button
   - Rules saved as part of the workflow

2. Integration into Space layout:
   - Agent management: accessible via SpaceNavPanel "Agents" link → renders `SpaceAgentList`/`SpaceAgentEditor` in middle column
   - Workflow management: via "Workflows" link → renders `WorkflowList`/`WorkflowEditor`
   - Back navigation between list and editor views

3. Export all new components from `packages/web/src/components/space/index.ts`

4. Write e2e tests:
   - Create a workflow with 3 steps from template
   - Add a custom rule targeting specific steps
   - Save and verify persistence
   - Edit existing workflow
   - Delete workflow
   - Create a custom agent, use it in a workflow step

**Acceptance criteria:**
- Rules can be created and associated with specific steps
- Tags help categorize workflows (for display only — not used for selection heuristics)
- Agent and workflow management integrated into Space layout
- Full CRUD flows work end-to-end
- No "Set as Default" UI anywhere — workflow selection is explicit (UI picker) or AI auto-select
- E2E tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

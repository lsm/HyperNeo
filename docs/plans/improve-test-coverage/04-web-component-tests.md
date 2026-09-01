# Milestone 04: Web — Component Tests

## Goal

Write tests for the highest-impact untested React/Preact components in `packages/web/src/components/`. Prioritized by line count, these components collectively account for thousands of uncovered lines. Tests use `@testing-library/preact` with `happy-dom` environment.

## Scope

Priority components (sorted by line count):

| File | Lines | Sub-area |
|------|-------|----------|
| `room/RoomAgents.tsx` | 1,093 | Room |
| `room/RoomSettings.tsx` | 772 | Room |
| `settings/FallbackModelsSettings.tsx` | 754 | Settings |
| `room/AgentTurnBlock.tsx` | 735 | Room |
| `MessageInput.tsx` | 677 | Top-level (partially covered) |
| `settings/AddSkillDialog.tsx` | 349 | Settings |
| `settings/EditSkillDialog.tsx` | 323 | Settings |
| `WorkspaceSelector.tsx` | 304 | Top-level |
| `room/TaskViewModelSelector.tsx` | 293 | Room |
| `room/ReadonlySessionChat.tsx` | 199 | Room |
| `settings/GeneralSettings.tsx` | 173 | Settings |
| `room/HeaderReviewBar.tsx` | 126 | Room |
| `room/RoomAgentContextStrip.tsx` | (small) | Room |

---

## Task 4.1: Write tests for RoomAgents.tsx

**Agent type**: coder

**Description**

`RoomAgents.tsx` (1,093 lines) is the largest untested component. It renders the list of agents active in a room, handles agent invocation UI, and displays agent state. Heavy use of signals and store subscriptions.

**Files to read first**

- `packages/web/src/components/room/RoomAgents.tsx`
- An existing room component test for patterns (e.g. `packages/web/src/components/room/__tests__/`)
- `packages/web/vitest.setup.ts`

**Files to create**

- `packages/web/src/components/room/__tests__/RoomAgents.test.tsx`

**Subtasks**

1. Read the component to identify its props interface, signal dependencies, and conditional rendering branches.
2. Mock all store/signal dependencies using `vi.mock()` or inline mock objects.
3. Write render tests for: empty agents list, single agent (idle), agent running, agent error state.
4. Write interaction tests for any click handlers (e.g., selecting an agent, invoking an agent).
5. Do not attempt to test real database or network interactions — mock them at the signal level.
6. Aim for at least 60% line coverage of `RoomAgents.tsx` (complex conditional rendering makes 100% impractical).

**Acceptance criteria**

- Test file exists and all tests pass.
- `RoomAgents.tsx` shows at least 60% line coverage in vitest report.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01 (vitest `coverage.include` must be set).

---

## Task 4.2: Write tests for AgentTurnBlock.tsx and RoomSettings.tsx

**Agent type**: coder

**Description**

Two large room components. `AgentTurnBlock.tsx` (735 lines) renders the content of a single agent turn in the chat (tool calls, text output, approval prompts). `RoomSettings.tsx` (772 lines) is the settings panel for a room.

**Files to read first**

- `packages/web/src/components/room/AgentTurnBlock.tsx`
- `packages/web/src/components/room/RoomSettings.tsx`
- Existing room component tests for mock patterns

**Files to create**

- `packages/web/src/components/room/__tests__/AgentTurnBlock.test.tsx`
- `packages/web/src/components/room/__tests__/RoomSettings.test.tsx`

**Subtasks**

1. For `AgentTurnBlock.tsx`:
   - Write render tests for each turn block type: text, tool_use, tool_result, thinking.
   - Test the approval prompt rendering (if present).
   - Mock SDK message types from `@neokai/shared/sdk/type-guards`.
2. For `RoomSettings.tsx`:
   - Write render tests for the main settings view.
   - Test form interactions (e.g. model selector, skill toggles).
   - Mock room store signals.
3. Aim for 60%+ line coverage on each file.

**Acceptance criteria**

- Both test files exist and pass.
- Each component shows at least 60% line coverage.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01.

---

## Task 4.3: Write tests for FallbackModelsSettings.tsx and settings dialogs

**Agent type**: coder

**Description**

The settings area has several completely untested components. `FallbackModelsSettings.tsx` (754 lines) is the most complex; `AddSkillDialog.tsx` (349 lines), `EditSkillDialog.tsx` (323 lines), and `GeneralSettings.tsx` (173 lines) are secondary priorities.

**Files to read first**

- `packages/web/src/components/settings/FallbackModelsSettings.tsx`
- `packages/web/src/components/settings/AddSkillDialog.tsx`
- `packages/web/src/components/settings/EditSkillDialog.tsx`
- `packages/web/src/components/settings/GeneralSettings.tsx`
- Existing settings tests (e.g. any `*.test.tsx` in `components/settings/`)

**Files to create**

- `packages/web/src/components/settings/__tests__/FallbackModelsSettings.test.tsx`
- `packages/web/src/components/settings/__tests__/AddSkillDialog.test.tsx`
- `packages/web/src/components/settings/__tests__/EditSkillDialog.test.tsx`
- `packages/web/src/components/settings/__tests__/GeneralSettings.test.tsx`

**Subtasks**

1. For each component, identify the props and store dependencies.
2. Mock stores/signals at the top of each test file using `vi.mock()`.
3. Write render tests covering the main display state and at least one user interaction per component.
4. For `FallbackModelsSettings.tsx` specifically, test the model ordering/priority logic if it's exposed as a pure function.
5. Aim for 50%+ line coverage on each file (settings dialogs have many conditional branches).

**Acceptance criteria**

- All four test files exist and pass.
- Each file shows at least 50% line coverage.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01.

---

## Task 4.4: Write tests for MessageInput.tsx, WorkspaceSelector.tsx, and TaskViewModelSelector.tsx

**Agent type**: coder

**Description**

`MessageInput.tsx` (677 lines) is partially covered (there is an existing `MessageInput.queue-mode.test.tsx`) but has significant uncovered paths. `WorkspaceSelector.tsx` (304 lines) and `TaskViewModelSelector.tsx` (293 lines) are fully untested.

**Files to read first**

- `packages/web/src/components/MessageInput.tsx`
- `packages/web/src/components/MessageInput.queue-mode.test.tsx` (existing test for context)
- `packages/web/src/components/WorkspaceSelector.tsx`
- `packages/web/src/components/room/TaskViewModelSelector.tsx`

**Files to create or modify**

- `packages/web/src/components/__tests__/MessageInput.test.tsx` (or extend existing test)
- `packages/web/src/components/__tests__/WorkspaceSelector.test.tsx`
- `packages/web/src/components/room/__tests__/TaskViewModelSelector.test.tsx`

**Subtasks**

1. For `MessageInput.tsx`:
   - Read the existing queue-mode test to understand the mock setup.
   - Add tests for: standard mode rendering, file attachment input, keyboard shortcuts (Enter to send, Shift+Enter for newline), empty-state disabling.
2. For `WorkspaceSelector.tsx`:
   - Test render with no workspaces, with one workspace selected, and with multiple workspaces.
   - Test the selection change handler.
3. For `TaskViewModelSelector.tsx`:
   - Test that the component renders the current model.
   - Test model change triggers the expected action.
4. Aim for 65%+ line coverage on `MessageInput.tsx`, 70%+ on the others.

**Acceptance criteria**

- All test files exist and pass.
- `MessageInput.tsx` shows at least 65% combined line coverage across both test files.
- `WorkspaceSelector.tsx` and `TaskViewModelSelector.tsx` show at least 70% line coverage.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01.

---

## Task 4.5: Write tests for remaining room components and small components

**Agent type**: coder

**Description**

Cover the remaining smaller room components: `ReadonlySessionChat.tsx`, `HeaderReviewBar.tsx`, `RoomAgentContextStrip.tsx`, and `RoomContext.tsx`.

**Files to read first**

- `packages/web/src/components/room/ReadonlySessionChat.tsx`
- `packages/web/src/components/room/HeaderReviewBar.tsx`
- `packages/web/src/components/room/RoomAgentContextStrip.tsx`
- `packages/web/src/components/room/RoomContext.tsx`

**Files to create**

- `packages/web/src/components/room/__tests__/ReadonlySessionChat.test.tsx`
- `packages/web/src/components/room/__tests__/HeaderReviewBar.test.tsx`
- `packages/web/src/components/room/__tests__/RoomAgentContextStrip.test.tsx`
- `packages/web/src/components/room/__tests__/RoomContext.test.tsx`

**Subtasks**

1. For each component, write at minimum: one render test (smoke test), one test for a key conditional branch, and one test for a user interaction if any.
2. Mock all store/signal dependencies.
3. These are smaller files so 70%+ line coverage is achievable with 3-5 tests each.

**Acceptance criteria**

- All four test files exist and pass.
- Each component shows at least 70% line coverage.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01.

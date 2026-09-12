# Milestone 05: Web — Hook and Utility Tests

## Goal

Fill gaps in test coverage for hooks, utility modules, and space-area components that are not yet covered. The hooks directory already has good coverage (27 of 29 hooks are tested), so this milestone is primarily about the `useChatComposerController` hook and the `space/` sub-area utilities which have several untested TS files.

## Scope

| File | Lines | Category |
|------|-------|----------|
| `hooks/useChatComposerController.ts` | 153 | Hook |
| `hooks/useSkills.ts` | 62 | Hook |
| `components/space/visual-editor/semanticWorkflowGraph.ts` | — | Space utility |
| `components/space/visual-editor/serialization.ts` | — | Space utility |
| `components/space/visual-editor/layout.ts` | — | Space utility |
| `components/space/export-import-utils.ts` | — | Space utility |
| `components/space/gate-status.ts` | — | Space utility |
| `components/space/workflow-templates.ts` | — | Space utility |
| `components/sdk/tools/tool-utils.ts` | — | SDK utility |
| `components/sdk/tools/tool-registry.ts` | — | SDK utility |

---

## Task 5.1: Write tests for useChatComposerController and useSkills hooks

**Agent type**: coder

**Description**

`useChatComposerController.ts` (153 lines) is the largest untested hook. `useSkills.ts` (62 lines) is a smaller gap. All other hooks already have test files under `packages/web/src/hooks/__tests__/`.

**Files to read first**

- `packages/web/src/hooks/useChatComposerController.ts`
- `packages/web/src/hooks/useSkills.ts`
- An existing hook test for patterns (e.g. `packages/web/src/hooks/__tests__/useChatBase.test.ts`)

**Files to create**

- `packages/web/src/hooks/__tests__/useChatComposerController.test.ts`
- `packages/web/src/hooks/__tests__/useSkills.test.ts`

**Subtasks**

1. For `useChatComposerController.ts`:
   - Identify all external dependencies (stores, signals, other hooks) and mock them.
   - Test the main composition logic: input handling, command detection, mention detection.
   - Test state transitions (empty input, input with text, input with @mention).
2. For `useSkills.ts`:
   - Test that skills are loaded from the store.
   - Test that the hook returns the correct shape.
3. Use `renderHook` from `@testing-library/preact` for both hooks.
4. Aim for 70%+ line coverage on `useChatComposerController.ts`, 80%+ on `useSkills.ts`.

**Acceptance criteria**

- Both test files exist and pass.
- Line coverage targets are met.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01.

---

## Task 5.2: Write tests for space visual-editor utilities

**Agent type**: coder

**Description**

The `packages/web/src/components/space/visual-editor/` directory has several pure utility TS files with no tests: `semanticWorkflowGraph.ts`, `serialization.ts`, `layout.ts`, `nodeMetrics.ts`. These are algorithmic (graph layout, serialization) and ideal for unit testing without DOM/store mocking.

**Files to read first**

- `packages/web/src/components/space/visual-editor/semanticWorkflowGraph.ts`
- `packages/web/src/components/space/visual-editor/serialization.ts`
- `packages/web/src/components/space/visual-editor/layout.ts`
- `packages/web/src/components/space/visual-editor/nodeMetrics.ts`

**Files to create**

- `packages/web/src/components/space/visual-editor/__tests__/semanticWorkflowGraph.test.ts`
- `packages/web/src/components/space/visual-editor/__tests__/serialization.test.ts`
- `packages/web/src/components/space/visual-editor/__tests__/layout.test.ts`

**Subtasks**

1. For `semanticWorkflowGraph.ts`: test graph construction from workflow definition objects, node/edge extraction, cycle detection if present.
2. For `serialization.ts`: test round-trip serialization (serialize then deserialize and confirm structural equality).
3. For `layout.ts`: test that the layout function returns valid node positions (e.g., no NaN coordinates, all nodes positioned).
4. Use fixture data from `packages/web/src/components/space/__tests__/fixtures/` if available (the `builtInTemplateWorkflows.ts` fixture may be useful).
5. These are pure functions — no mocking required.

**Acceptance criteria**

- All test files exist and pass.
- Each target file shows at least 70% line coverage.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01.

---

## Task 5.3: Write tests for space utility files and SDK tool utilities

**Agent type**: coder

**Description**

Cover the remaining small utility files: `export-import-utils.ts`, `gate-status.ts`, `workflow-templates.ts`, `thread/space-task-thread-events.ts`, and SDK tool utilities `tool-utils.ts` and `tool-registry.ts`.

**Files to read first**

- `packages/web/src/components/space/export-import-utils.ts`
- `packages/web/src/components/space/gate-status.ts`
- `packages/web/src/components/space/workflow-templates.ts`
- `packages/web/src/components/sdk/tools/tool-utils.ts`
- `packages/web/src/components/sdk/tools/tool-registry.ts`

**Files to create**

- `packages/web/src/components/space/__tests__/export-import-utils.test.ts`
- `packages/web/src/components/space/__tests__/gate-status.test.ts`
- `packages/web/src/components/space/__tests__/workflow-templates.test.ts`
- `packages/web/src/components/sdk/tools/__tests__/tool-utils.test.ts`
- `packages/web/src/components/sdk/tools/__tests__/tool-registry.test.ts`

**Subtasks**

1. For `export-import-utils.ts`: test export serialization and import parsing with sample space data.
2. For `gate-status.ts`: test status classification functions with each possible status value.
3. For `workflow-templates.ts`: test that template generation returns the expected workflow shape.
4. For `tool-utils.ts` and `tool-registry.ts`: test tool registration, lookup by name, and any type-guard utilities.
5. These are all pure utility modules — mock minimally.

**Acceptance criteria**

- All test files exist and pass.
- Each file shows at least 75% line coverage.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01.

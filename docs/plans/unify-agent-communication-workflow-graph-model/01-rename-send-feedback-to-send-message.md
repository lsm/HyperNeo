# Milestone 1: Rename `send_feedback` to `send_message`

## Goal

Rename the `send_feedback` tool to `send_message` across all schemas, handlers, tests, and system prompt text. This is a pure mechanical rename with no behavioral change -- the tool's semantics, validation, and routing logic remain identical.

## Scope

- Zod schema rename (`SendFeedbackSchema` -> `SendMessageSchema`, `SendFeedbackInput` -> `SendMessageInput`)
- Handler function rename (`send_feedback` -> `send_message`)
- MCP tool registration name change
- All test files referencing `send_feedback`
- System prompt text that mentions the tool name
- Documentation references in code comments

## Tasks

### Task 1.1: Rename schema and types in step-agent-tool-schemas.ts

**Description:** Rename `SendFeedbackSchema` to `SendMessageSchema` and `SendFeedbackInput` to `SendMessageInput` in the schema definition file. Update the aggregate export `STEP_AGENT_TOOL_SCHEMAS` to use `send_message` as the key. Update all JSDoc comments.

**Subtasks:**
1. Run `bun install` at worktree root.
2. In `packages/daemon/src/lib/space/tools/step-agent-tool-schemas.ts`:
   - Rename `SendFeedbackSchema` -> `SendMessageSchema`
   - Rename `SendFeedbackInput` -> `SendMessageInput`
   - Update `STEP_AGENT_TOOL_SCHEMAS` key from `send_feedback` to `send_message`
   - Update all comments referencing `send_feedback` to `send_message`
3. In `packages/daemon/src/lib/space/tools/step-agent-tools.ts`:
   - Update imports: `SendFeedbackSchema` -> `SendMessageSchema`, `SendFeedbackInput` -> `SendMessageInput`
   - Rename the handler function from `send_feedback` to `send_message`
   - Update the MCP tool registration from `'send_feedback'` to `'send_message'`
   - Update all comments and suggestion strings referencing `send_feedback`
4. In `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`:
   - Update any references to `send_feedback` in comments or code
5. In `packages/daemon/src/lib/agents/custom-agent.ts`:
   - Update any system prompt text or comments referencing `send_feedback`
6. Search for any remaining references to `send_feedback` in `packages/daemon/src/` and update them.
7. Run `bun run typecheck` to verify no type errors.
8. Run `bun run lint` to verify no lint errors.
9. Run affected tests: `cd packages/daemon && bun test tests/unit/space/step-agent-tools.test.ts tests/unit/space/task-agent-tool-schemas.test.ts`

**Acceptance Criteria:**
- Zero references to `send_feedback` remain in `packages/daemon/src/` (except historical docs/plans)
- `bun run typecheck` passes
- All existing step-agent-tools tests pass (they reference the new name)

**Dependencies:** None

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 1.2: Update all daemon test files referencing send_feedback

**Description:** Update all test files in `packages/daemon/tests/` that reference `send_feedback` to use `send_message`. This includes test descriptions, assertions, mock tool names, and inline comments.

**Subtasks:**
1. Run `bun install` at worktree root.
2. Search for `send_feedback` across all files in `packages/daemon/tests/`.
3. Update each occurrence:
   - `packages/daemon/tests/unit/space/step-agent-tools.test.ts` -- tool handler name, test descriptions
   - `packages/daemon/tests/unit/space/custom-agent.test.ts` -- any references
   - `packages/daemon/tests/unit/space/cross-agent-messaging.test.ts` -- tool name references
   - `packages/daemon/tests/unit/space/cross-agent-messaging-integration.test.ts` -- tool name references
4. Run all affected tests to verify they pass.
5. Run `bun run typecheck` and `bun run lint`.

**Acceptance Criteria:**
- Zero references to `send_feedback` remain in `packages/daemon/tests/` (except historical docs)
- All renamed tests pass
- No regressions in other space tests

**Dependencies:** Task 1.1

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### ~~Task 1.3: Collapsed into Task 1.1~~

Task 1.3 (system prompt text updates) has been merged into Task 1.1 since it already covers `task-agent.ts` and the full codebase sweep for remaining references. Task 1.1 subtask 6 now serves as the catch-all for any remaining references outside `docs/plans/`.

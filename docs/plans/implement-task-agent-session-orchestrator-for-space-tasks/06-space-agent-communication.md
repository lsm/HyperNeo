# Milestone 6: Space Agent Communication

## Goal

Enable bidirectional communication between the Space Agent and Task Agent sessions. The Space Agent needs a tool to send messages to Task Agents (for status checks, redirects, and feedback), and Task Agent needs a way to notify the Space Agent when tasks complete or need attention.

## Tasks

### Task 6.1: Add `send_message_to_task` Tool to Space Agent

**Description:** Add a new MCP tool to the Space Agent's tool set that allows it to send messages to a specific Task Agent session.

**Subtasks:**
1. In `packages/daemon/src/lib/space/tools/space-agent-tools.ts`, add a new `send_message_to_task` handler to `createSpaceAgentToolHandlers`:
   - Input: `{ task_id: string, message: string }`
   - Looks up the task by ID from the task repository
   - Validates the task has a `taskAgentSessionId`
   - Injects the message into the Task Agent session via the `TaskAgentManager`
   - Returns success/failure with the task's current status
2. Add the `TaskAgentManager` to `SpaceAgentToolsConfig` (optional field, null-safe -- when not configured, the tool returns an error message)
3. Register the tool in `createSpaceAgentMcpServer` with appropriate Zod schema and description
4. Update the Space Chat Agent system prompt (`buildSpaceChatSystemPrompt` in `space-chat-agent.ts`) to document the new `send_message_to_task` tool:
   - When to use it: check task progress, provide feedback, redirect work
   - The message will be delivered to the Task Agent which may relay relevant parts to its active sub-session
5. Write unit tests for the new handler covering:
   - Successful message delivery
   - Task not found
   - Task has no Task Agent session
   - TaskAgentManager not configured
6. Update existing `space-agent-tools.test.ts` with the new tool
7. Run `bun run typecheck` and `make test-daemon`

**Acceptance Criteria:**
- Space Agent can send messages to Task Agent sessions via `send_message_to_task`
- Error handling covers all edge cases
- System prompt documents the new tool
- Existing Space Agent tool tests continue to pass
- New tests cover the added tool

**Dependencies:** Task 4.1 (needs TaskAgentManager class). Note: Does not depend on 4.3 (DaemonApp wiring) — the tool handler receives TaskAgentManager via its config interface. Can run in parallel with 4.2, 4.3, and 5.1.

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 6.2: Add Task Completion Notification to Space Agent

**Description:** When a Task Agent completes or fails a task (via `report_result`), notify the Space Agent session so it can take appropriate action (start next task, alert the user, etc.).

**Subtasks:**
1. In `packages/daemon/src/lib/space/tools/task-agent-tools.ts`, extend the `report_result` handler to emit a notification after updating the task status:
   - Use the DaemonHub event system to emit a `space.task.completed` or `space.task.failed` event
   - The event payload should include: `taskId`, `spaceId`, `status`, `summary`, `workflowRunId`
2. In the Space Agent provisioning (`provision-global-agent.ts` or the per-space agent setup), subscribe to `space.task.completed` and `space.task.failed` events:
   - When received, inject a notification message into the Space Agent session informing it that a task has completed or failed
   - Message format: "Task '{title}' has {completed|failed}. Summary: {summary}"
3. **Extend `DaemonEventMap`** in `packages/daemon/src/lib/daemon-hub.ts`: add `'space.task.completed'` and `'space.task.failed'` event types with payload interface `{ taskId: string, spaceId: string, status: string, summary: string, workflowRunId: string, taskTitle: string }`. This is a separate, explicit deliverable — not just a side effect of the handler work.
4. Write unit tests verifying:
   - `report_result` emits the correct event
   - Space Agent session receives the notification message
   - Events include correct payload data
5. Run `bun run typecheck` and `make test-daemon`

**Acceptance Criteria:**
- Task completion/failure emits events via DaemonHub
- Space Agent session receives notification messages when tasks complete or fail
- Event payloads contain task context for the Space Agent to reason about
- Tests verify the event emission and message injection

**Dependencies:** Task 3.1 (`report_result` handler), Task 6.1 (Space Agent needs to be able to respond to task events)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 6.3: End-to-End Online Test

**Description:** Write an online test that exercises the full Task Agent lifecycle: pending task pickup, Task Agent session creation, sub-session spawning, workflow advancement, and completion notification.

**Subtasks:**
1. Create `packages/daemon/tests/online/space/task-agent-lifecycle.test.ts`
2. Set up test fixtures:
   - Create a Space with a simple 2-step workflow (code -> review)
   - Create seed agents (coder, reviewer)
   - Create a workflow run with a pending task for the first step
3. Test the lifecycle:
   - Verify SpaceRuntime picks up the pending task and spawns a Task Agent session
   - Verify the Task Agent session has MCP tools attached
   - Verify the Task Agent can use `spawn_step_agent` to create a sub-session
   - Verify the Task Agent can use `check_step_status` to monitor the sub-session
   - Verify the Task Agent can use `advance_workflow` to move to the next step
   - Verify the Task Agent can use `report_result` to complete the task
   - Verify the Space Agent receives a completion notification
4. Use `HYPERNEO_USE_DEV_PROXY=1` for mocked API calls following the test patterns in `packages/daemon/tests/online/`
5. Run the test and verify it passes

**Acceptance Criteria:**
- Online test covers the full Task Agent lifecycle from pending task to completion
- Test uses dev proxy for mocked API calls
- All assertions verify correct state transitions and session management
- Test is reproducible and not flaky

**Dependencies:** All previous milestones (5.1, 5.2, 6.1, 6.2)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

# Milestone 3: Unified Messaging Model

## Goal

Remove the two special-purpose messaging tools (`relay_message` for Task Agent and `request_peer_input` for node agents) and replace them with a single `send_message` tool used by all agents. Channel topology enforcement applies uniformly to everyone -- the Task Agent has channels to all nodes by default, so it can reach everyone, but via the same mechanism.

## Scope

- Remove `relay_message` tool from task-agent-tools and task-agent-tool-schemas
- Remove `request_peer_input` tool from step-agent-tools (now node-agent-tools after M2) and schemas
- Give the Task Agent the `send_message` tool (same tool that node agents use)
- Update `ChannelResolver` so that the Task Agent is resolved via channel topology like everyone else (no bypass logic)
- Auto-include Task Agent <-> all node agents as default channels in the channel topology when starting a workflow run
- Update all system prompts to reflect the unified model
- Remove `injectToTaskAgent` callback from node agent tool config (no longer needed)

## Tasks

### Task 3.1: Remove `relay_message` from Task Agent tools

**Description:** Remove the `relay_message` tool handler and schema from the Task Agent tool set. The Task Agent will use `send_message` instead (added in Task 3.3).

**Subtasks:**
1. Run `bun install` at worktree root.
2. In `packages/daemon/src/lib/space/tools/task-agent-tool-schemas.ts`:
   - Remove `RelayMessageSchema` and `RelayMessageInput` type
   - Remove from aggregate export
3. In `packages/daemon/src/lib/space/tools/task-agent-tools.ts`:
   - Remove the `relay_message` handler function
   - Remove the `relay_message` MCP tool registration
   - Remove imports of `RelayMessageSchema` and `RelayMessageInput`
   - Update comments referencing `relay_message`
4. Update `packages/daemon/src/lib/space/runtime/channel-resolver.ts`:
   - Remove comments about "Task Agent override" and `relay_message` bypass
5. Run `bun run typecheck`.
6. Update tests in `packages/daemon/tests/unit/space/task-agent-tools.test.ts`:
   - Remove `relay_message` test cases
7. Update `packages/daemon/tests/unit/space/task-agent-tool-schemas.test.ts`:
   - Remove `relay_message` schema tests
8. Update cross-agent messaging tests that reference `relay_message`.
9. Run all affected tests.

**Acceptance Criteria:**
- Zero references to `relay_message` in source code (outside historical docs)
- Task Agent tool set no longer includes `relay_message`
- All tests pass

**Dependencies:** Milestone 1 (send_feedback already renamed to send_message)

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3.2: Remove `request_peer_input` from node agent tools

**Description:** Remove the `request_peer_input` tool handler and schema from the node agent (formerly step agent) tool set. Node agents will use only `send_message` for all communication.

**Subtasks:**
1. Run `bun install` at worktree root.
2. In `packages/daemon/src/lib/space/tools/step-agent-tool-schemas.ts` (or renamed file after M2):
   - Remove `RequestPeerInputSchema` and `RequestPeerInputInput` type
   - Remove from aggregate export
3. In `packages/daemon/src/lib/space/tools/step-agent-tools.ts` (or renamed):
   - Remove the `request_peer_input` handler function
   - Remove the `request_peer_input` MCP tool registration
   - Remove `injectToTaskAgent` from `StepAgentToolsConfig` (no longer needed)
   - Remove imports of `RequestPeerInputSchema` and `RequestPeerInputInput`
4. Update `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`:
   - Remove the `injectToTaskAgent` wiring from the config passed to `createStepAgentToolHandlers`
5. Update `packages/daemon/src/lib/agents/custom-agent.ts`:
   - Remove any references to `request_peer_input` in system prompt text or comments
6. In `send_message` handler: remove all suggestions to use `request_peer_input` as fallback. When no channel topology is declared, return a clear error message (no fallback tool suggestion). **Note:** Backward compatibility for existing topology-less workflows is not required — this feature is not yet in production.
7. Run `bun run typecheck`.
8. Update tests:
   - `packages/daemon/tests/unit/space/step-agent-tools.test.ts` -- remove `request_peer_input` tests
   - `packages/daemon/tests/unit/space/custom-agent.test.ts` -- update references
   - `packages/daemon/tests/unit/space/cross-agent-messaging.test.ts` -- update references
9. Run all affected tests.

**Acceptance Criteria:**
- Zero references to `request_peer_input` in source code (outside historical docs)
- Node agent tool set is: `list_peers` + `send_message` only
- `injectToTaskAgent` removed from tool config
- All tests pass

**Dependencies:** Milestone 1 (send_feedback renamed), Task 3.1

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3.3: Give Task Agent the `send_message` tool via channel topology

**Description:** Add the `send_message` tool to the Task Agent's MCP server. The Task Agent uses the same tool and the same channel topology enforcement as node agents. Auto-generate default bidirectional channels between the Task Agent and all node agents when starting a workflow run.

**Subtasks:**
1. Run `bun install` at worktree root.
2. Update `packages/daemon/src/lib/space/runtime/space-runtime.ts` (or equivalent):
   - When resolving channels at step-start (`storeResolvedChannels`), auto-add bidirectional channels between `task-agent` role and every node agent role in the step
   - These default channels are added in addition to user-declared channels
   - Only add if not already declared by the user (avoid duplicates)
3. Update `packages/daemon/src/lib/space/tools/task-agent-tools.ts`:
   - Add `send_message` to the Task Agent MCP server using the same `SendMessageSchema`
   - The Task Agent's `send_message` handler follows the same pattern as the node agent one: validates against channel topology, resolves targets by role, injects message
   - The Task Agent's role is `'task-agent'` -- used for channel resolution
   - Reuse or share the message injection logic
4. Update `list_group_members` in task-agent-tools:
   - Remove the note about Task Agent having "unrestricted relay access"
   - Update to show `permittedTargets` based on channel topology (same as node agents' `list_peers`)
5. Update the Task Agent system prompt in `packages/daemon/src/lib/space/agents/task-agent.ts`:
   - Remove references to `relay_message`
   - Document that `send_message` is used for all inter-agent communication
   - Document that the Task Agent has default channels to all node agents
6. Run `bun run typecheck` and `bun run lint`.
7. Write new tests:
   - Test that Task Agent's `send_message` validates against channel topology
   - Test that default Task Agent <-> node agent channels are auto-generated
   - Test that removing a Task Agent channel prevents messaging (no bypass)
8. Update existing cross-agent messaging tests.
9. Run all affected tests.

**Acceptance Criteria:**
- Task Agent uses `send_message` for all communication with node agents
- Channel topology enforcement is uniform -- Task Agent has no bypass/override
- Default bidirectional channels are auto-created between Task Agent and all node agent roles
- If a user removes a Task Agent channel, the Task Agent can no longer message that node
- All tests pass, new tests cover the unified model

**Dependencies:** Task 3.1, Task 3.2

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3.4: Update cross-agent messaging tests and e2e

**Description:** Comprehensive test update for the unified messaging model. Ensure all cross-agent messaging scenarios work with the single `send_message` tool.

**Subtasks:**
1. Run `bun install` at worktree root.
2. Rewrite `packages/daemon/tests/unit/space/cross-agent-messaging.test.ts`:
   - All scenarios use `send_message` only
   - Test Task Agent -> node agent messaging via channel topology
   - Test node agent -> Task Agent messaging via channel topology
   - Test node agent -> node agent messaging via channel topology
   - Test rejection when channel not declared (no fallback tool)
3. Rewrite `packages/daemon/tests/unit/space/cross-agent-messaging-integration.test.ts`:
   - Full integration flow using unified `send_message`
4. Add test: Task Agent channel removal prevents messaging
5. Add test: custom channel topology with Task Agent as a regular participant
6. Run all space tests: `cd packages/daemon && bun test tests/unit/space/`
7. Update e2e test `packages/e2e/tests/features/space-session-groups.e2e.ts` if it references old tool names.

**Acceptance Criteria:**
- Comprehensive test coverage for unified messaging model
- No references to `relay_message` or `request_peer_input` in tests
- All tests pass
- E2E tests updated if applicable

**Dependencies:** Task 3.3

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

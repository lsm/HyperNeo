# Milestone 5: Integration Verification

## Milestone Goal

Verify that the room runtime correctly wires all restructured agents. Ensure the `QueryOptionsBuilder` correctly propagates agent/agents configuration to the SDK, and that the room runtime's agent spawning paths all work with the always-on pattern.

## Scope

- `packages/daemon/src/lib/room/runtime/room-runtime.ts` — Verify integration points
- `packages/daemon/src/lib/agent/query-options-builder.ts` — Verify agent/agents propagation
- `packages/daemon/tests/unit/room/` — Integration-focused unit tests

## Tasks

### Task 5.1: Verify QueryOptionsBuilder propagates always-on agents correctly

**Description:** Review and test that `QueryOptionsBuilder.build()` correctly handles the agent/agents configuration from the always-on pattern. When `session.config.agent` and `session.config.agents` are set (which they always are now), they should flow through to the SDK `Options` correctly. Verify there are no edge cases where the agents map is dropped or overwritten.

**Subtasks:**
1. Review the `QueryOptionsBuilder.build()` method for agent/agents handling (lines 147-149)
2. Verify that when `coordinatorMode` is OFF (which it is for room agents), the agent/agents from session config are used directly
3. Verify that when `coordinatorMode` is ON, the coordinator agents are used instead (this path should be unchanged)
4. Add unit test: verify `QueryOptionsBuilder` preserves agent/agents from session config
5. Add unit test: verify `coordinatorMode` does not interfere with room agent configurations
6. Verify worktree isolation text append works correctly when agents are always present (the worktree prompt append in coordinator mode iterates over agents — verify this also works for room agents)

**Acceptance Criteria:**
- No bugs found in QueryOptionsBuilder's handling of always-on agents
- Unit tests verify agent/agents propagation
- Worktree isolation works correctly with always-on agents
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Milestones 1-3 (all implementation complete)
**Agent type:** coder

---

### Task 5.2: Verify room-runtime agent spawning paths

**Description:** Review the room runtime's agent spawning paths to ensure they work correctly with the restructured agents. The key integration points are: `startGoalAutonomous()` which spawns coder/planner sessions, and `createLeaderCallbacks()` which creates leader sessions. Verify no code paths assume the old conditional pattern.

**Subtasks:**
1. Review `room-runtime.ts` `startGoalAutonomous()` (around line 4120) — verify it calls `createCoderAgentInit()` and `createPlannerAgentInit()` correctly
2. Review `room-runtime.ts` leader creation paths — verify they call `createLeaderAgentInit()` correctly
3. Check if any code in room-runtime inspects `agentSubagents.worker` separately from the agent factory — if so, it may need updating
4. Review `room-runtime.ts` lines 1304, 1420, 1553 where `agentSubagents` is directly accessed — verify these are for reviewer/leader config checks, not coder agent checks. **Important:** Verify and document that `hasReviewers` (derived from `room.config.agentSubagents.leader`) checks user-configured reviewers only, not built-in `leader-explorer`/`leader-fact-checker` sub-agents. The gate logic (PR review requirement) should only depend on user intent, not on runtime agent map contents
5. Add integration-style unit test: mock the room runtime's agent spawning and verify the correct init objects are produced for coder, planner, and leader agents
6. Document any edge cases or assumptions found

**Acceptance Criteria:**
- All room-runtime agent spawning paths verified compatible with always-on pattern
- No code paths assume conditional agent/agents
- Integration tests verify correct init production
- Any necessary fixes applied
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Task 5.1
**Agent type:** coder

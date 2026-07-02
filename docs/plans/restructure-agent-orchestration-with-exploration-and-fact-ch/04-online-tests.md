# Milestone 4: Online Tests for Agent Orchestration

## Milestone Goal

Create dev-proxy-based online tests that verify the restructured agent orchestration works end-to-end. These tests use mocked SDK responses to validate that the correct sub-agents are spawned, context is passed correctly, and the agent/agents pattern functions as expected.

## Scope

- `packages/daemon/tests/online/room/` — New online test files

## Tasks

### Task 4.1: Online test for coder agent with built-in sub-agents

**Description:** Create an online test that verifies the coder agent correctly uses the always-on agent/agents pattern. The test should create a coder session and verify that the SDK receives the correct agent/agents configuration with built-in `coder-explorer` and `coder-tester` sub-agents.

**Subtasks:**
1. Create `packages/daemon/tests/online/room/coder-agent-subagents.test.ts`
2. Use dev-proxy mode (`HYPERNEO_USE_DEV_PROXY=1`) for mocked responses
3. Test: create a coder session via `createCoderAgentInit()` and verify the resulting `Options` passed to SDK contain `agent: 'Coder'` and `agents` with `coder-explorer` and `coder-tester`
4. Test: verify coder session without room-configured helpers still has built-in sub-agents
5. Test: verify coder session with room-configured helpers has both built-ins and custom helpers
6. Verify no test makes real API calls (check dev-proxy logs)

**Acceptance Criteria:**
- Tests pass with `HYPERNEO_USE_DEV_PROXY=1`
- Tests verify agent/agents configuration in SDK options
- Tests cover both with and without room-configured helpers
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Milestone 1 (all tasks)
**Agent type:** coder

---

### Task 4.2: Online test for planner 3-phase pipeline

**Description:** Create an online test that verifies the planner's 3-phase pipeline (`planner-explorer` -> `planner-fact-checker` -> `plan-writer`). The test should verify that the planner session is configured with all three sub-agents and that the planner agent definition correctly describes the 3-phase orchestration.

**Subtasks:**
1. Create `packages/daemon/tests/online/room/planner-three-phase.test.ts`
2. Use dev-proxy mode for mocked responses
3. Test: create a planner session and verify agents map contains Planner, `planner-explorer`, `planner-fact-checker`, `plan-writer`
4. Test: verify `plan-writer` agent definition does NOT include Task tools
5. Test: verify `planner-fact-checker` has only `['WebSearch', 'WebFetch']` tools (no Read/Grep/Glob)
6. Test: verify planner system prompt describes 3-phase pipeline
7. **Context-passing integration test:** Mock sub-agent responses and verify that the planner correctly threads context between phases. Specifically:
   - Mock `planner-explorer` to return a `---EXPLORER_FINDINGS---` block
   - Verify the prompt constructed for `planner-fact-checker` includes the explorer findings verbatim
   - Mock `planner-fact-checker` to return a `---FACT_CHECK_RESULT---` block
   - Verify the prompt constructed for `plan-writer` includes both explorer findings and fact-checker results
8. Verify no test makes real API calls

**Acceptance Criteria:**
- Tests pass with `HYPERNEO_USE_DEV_PROXY=1`
- Tests verify 3-phase pipeline configuration
- Tests verify plan-writer has no Task tools
- Tests verify context is correctly threaded between phases
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Milestone 2 (all tasks)
**Agent type:** coder

---

### Task 4.3: Online test for reviewer and leader with exploration sub-agents

**Description:** Create an online test that verifies reviewers have exploration and fact-checking sub-agents and the leader always uses the agent/agents pattern. Test both SDK-based and CLI-based reviewer configurations.

**Subtasks:**
1. Create `packages/daemon/tests/online/room/reviewer-leader-subagents.test.ts`
2. Use dev-proxy mode for mocked responses
3. Test: create a leader session with reviewer config and verify reviewer agents have Task tools
4. Test: verify agents map includes `reviewer-explorer` and `reviewer-fact-checker`
5. Test: verify reviewer sub-agents lack Task tools
6. Test: verify leader session without reviewers still has built-in `leader-explorer` and `leader-fact-checker` sub-agents
7. Test: verify leader always has `agent: 'Leader'` and `agents` map (no simple-path fallback)

**Acceptance Criteria:**
- Tests pass with `HYPERNEO_USE_DEV_PROXY=1`
- Tests verify reviewer sub-agent configuration
- Tests verify leader always-on pattern
- Tests cover both with and without reviewer configuration
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Milestone 3 (all tasks)
**Agent type:** coder

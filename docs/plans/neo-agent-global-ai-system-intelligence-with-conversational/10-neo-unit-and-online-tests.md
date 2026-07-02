# Milestone 10: Neo Unit and Online Tests

## Goal

Gap coverage for Neo backend features that span multiple milestones and cannot be fully tested within individual tasks: online conversation flows, cross-system integration, and session persistence across restarts. Individual tool handler unit tests are included in their respective milestone tasks (M1-M5).

## Scope

- Online tests for full multi-turn conversation flows with mocked SDK (requires M1-M5 to be complete)
- Cross-system integration tests (e.g., "create a goal in room X" verifies goal exists)
- Session persistence and recovery tests

## Tasks

### Task 10.1: Neo Integration and Gap Coverage Unit Tests

**Description**: Fill gaps in test coverage that span multiple milestones. Individual tool handler unit tests are already included in M1-M5 tasks. This task covers cross-cutting integration tests.

**Subtasks**:
1. Create `packages/daemon/tests/unit/neo/` test directory (if not already created by earlier tasks)
2. Write cross-system integration tests: Neo tool calls that touch multiple managers (e.g., create goal in a specific room requires RoomManager + GoalManager coordination)
3. Write confirmation round-trip tests: pending action store → confirm_action → execution → activity log entry (end-to-end flow through multiple components)
4. Write session health check and recovery tests: simulate crashed session → health check triggers → auto-recovery → session functional
5. Write activity log retention tests: verify pruning logic (30 days / 10,000 rows)
6. Write origin metadata end-to-end tests: Neo sends message to room → verify origin persisted → verify room agent sees it
7. Ensure all tests use unit test setup (no real API calls)

**Acceptance Criteria**:
- Cross-system integration tests verify multi-manager coordination
- Confirmation round-trip is tested end-to-end
- Session recovery is tested
- Activity log retention works correctly
- All tests pass with `make test-daemon`

**Dependencies**: Tasks 2.1-2.4, 3.1-3.5, 5.1-5.2

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 10.2: Neo Online Conversation Flow Tests

**Description**: Write online tests that verify full conversation flows through the Neo agent.

**Subtasks**:
1. Create `packages/daemon/tests/online/neo/` test directory
2. Write conversation flow tests (using dev proxy mock SDK):
   - Query flow: send "what rooms do I have?" -> verify Neo uses `list_rooms` tool -> structured response
   - Action flow: send "create a goal in room X" -> verify Neo uses `create_goal` tool -> goal created
   - Confirmation flow: send "delete room X" -> verify confirmation card -> confirm -> room deleted
   - Multi-turn: query -> action -> query again (verify state changed)
3. Write security tier enforcement tests:
   - Balanced mode: low-risk auto-executes, medium-risk confirms
   - Conservative mode: everything confirms
   - Autonomous mode: nothing confirms
4. Write activity feed accuracy tests:
   - Perform several actions -> verify all logged correctly in activity table
5. Write session persistence test:
   - Send messages -> restart daemon -> verify history preserved
6. All tests use `HYPERNEO_USE_DEV_PROXY=1` for mocked SDK responses

**Acceptance Criteria**:
- Conversation flows work end-to-end with mocked SDK
- Security tiers enforce correctly in each mode
- Activity feed records all actions accurately
- Session survives daemon restart
- All tests pass

**Dependencies**: Tasks 4.1, 5.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

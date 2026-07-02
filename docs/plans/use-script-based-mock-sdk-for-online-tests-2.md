# Plan: Use Script-Based Mock SDK for Online Tests

**Created:** March 2026

## Goal

Extend the use of the existing script-based mock SDK for online tests, particularly for time-consuming room feature tests. Where possible, convert API-dependent tests to use mock mode to improve test stability, reduce execution time, and lower API costs. For tests that require real API calls (e.g., multi-agent room flows), keep them as API-dependent but explore enhancements to the mock SDK that could support them in the future.

## Background

The codebase already has a comprehensive mock SDK (`packages/daemon/tests/helpers/mock-sdk.ts`) that provides:
- Message builders (`sdkAssistantText`, `sdkToolResult`, etc.)
- Pre-built scenarios (`simpleTextResponse`, `toolUseResponse`, etc.)
- Room-specific scripts (`plannerFull`, `coder`, `leader`, `chat`)
- Auto-mock installer (`installRoomAutoMock`)

Currently (11 tests already support mock mode):
- `agent-pipeline.test.ts` - uses mock SDK (always)
- `room-chat-constraints.test.ts` - supports mock mode via `HYPERNEO_AGENT_SDK_MOCK=1`
- `message-persistence.test.ts` - supports mock mode
- `message-delivery-mode-queue.test.ts` - supports mock mode
- `rpc-message-handlers.test.ts` - supports mock mode
- `session-resume.test.ts` - supports mock mode
- `multiturn-conversation.test.ts` - supports mock mode
- `agent-session-sdk.test.ts` - supports mock mode
- `selective-rewind.test.ts` - supports mock mode
- `rewind-feature.test.ts` - supports mock mode
- `sdk-streaming-failures.test.ts` - supports mock mode

Note: Most other room tests (multi-agent flows) make real API calls

## Tasks

### Task 1: Audit and categorize online tests

**Agent: general**

Focus on identifying high-value conversion candidates. Audit tests NOT yet supporting mock mode:

Priority targets:
- Room tests (excluding multi-agent flows like `room-multi-agent-flow.test.ts`, `room-planner-two-phase.test.ts`, `room-reviewer-flow.test.ts`)
- Feature tests (`auto-title.test.ts`, etc.)
- RPC/state tests

Skip (already verified to work with mock or must use real API):
- 11 tests already supporting mock (listed in Background)
- Provider tests (Anthropic, OpenAI, GLM)
- Multi-agent room flows

**Acceptance Criteria:**
- List of 3-5 specific test files to convert in Tasks 2-3
- Brief rationale for each (e.g., "simple RPC handler, no AI needed")
- Exclude list of tests that must remain API-dependent

### Task 2: Convert room chat tests to mock mode

**Agent: coder**

Convert room tests to support mock mode (similar to `room-chat-constraints.test.ts`):

Reference pattern from `room-chat-constraints.test.ts`:
```typescript
const IS_MOCK = !!process.env.HYPERNEO_AGENT_SDK_MOCK;
const SETUP_TIMEOUT = IS_MOCK ? 10000 : 30000;
const IDLE_TIMEOUT = IS_MOCK ? 5000 : 120000;

// In beforeEach:
if (IS_MOCK && daemon.mockControls) {
    daemon.mockControls.setDefaultResponses(simpleTextResponse('response'));
}
```

Files to convert:
- `room-advanced-scenarios.test.ts` - verify room scenario handling (no multi-agent)
- Other room tests identified in Task 1 audit that don't require multi-agent tool execution


**Acceptance Criteria:**
- Tests pass with `HYPERNEO_AGENT_SDK_MOCK=1` with mock timeout ≤5s (idle/response time)
- Tests still work with real API (default mode) with timeout ≥60s (idle/response time)
- Total test execution time reduced by ≥50% compared to real API mode
- Follows the IS_MOCK pattern for conditional timeouts

### Task 3: Convert remaining feature tests to mock mode

**Agent: coder**

Convert any feature tests identified in Task 1 that aren't already supporting mock:

Reference pattern (same as Task 2):
- Use `HYPERNEO_AGENT_SDK_MOCK` environment variable detection
- Set conditional timeouts based on mock vs real mode

Files to convert (from Task 1 audit):
- `auto-title.test.ts` - verify title generation metadata without real API
- Other tests identified in audit that don't require real AI behavior


**Acceptance Criteria:**
- Tests pass with mock SDK with mock timeout ≤5s (idle/response time)
- Tests still work with real API (default mode) with timeout ≥60s (idle/response time)
- Total test execution time reduced by ≥50% compared to real API mode
- Tests verify the core functionality (state transitions, persistence, etc.)
- Follows the IS_MOCK pattern for conditional timeouts

### Task 4: Enhance mock SDK if needed

**Agent: coder**

Based on the conversion work, identify any gaps in the mock SDK:
- Add new message builders if needed
- Extend room scripts if needed for specific test scenarios
- Document any limitations

This task runs only if gaps are identified during Tasks 2-3 conversion work.

**Acceptance Criteria:**
- Any enhancements are backwards-compatible
- New features are documented in mock-sdk.ts

### Task 5: Update CI to run tests in mock mode by default

**Agent: coder**

Update CI configuration to run converted tests in mock mode by default:
- Modify test runner scripts to set `HYPERNEO_AGENT_SDK_MOCK=1` for appropriate tests
- Ensure API-dependent tests still run with real API (perhaps on a separate schedule or with explicit flag)
- Document which tests require real API


**Acceptance Criteria:**
- CI runs most online tests in mock mode
- Execution time reduction ≥50% for converted tests
- No regression in test coverage

### Task 6: Verify and measure improvements

**Agent: general**

Run all converted tests to verify they work correctly:
- Run with `HYPERNEO_AGENT_SDK_MOCK=1` (mock mode) - all should pass
- Run without the env var - tests that can't use mock should skip or fail gracefully
- Measure execution time improvement

**Acceptance Criteria:**
- All converted tests pass in mock mode with timeout ≤5s (idle/response time)
- Tests still pass in real API mode with timeout ≥60s (idle/response time)
- Test execution time reduced by ≥50% (e.g., from 120s to ≤60s per test)
- API costs reduced for CI runs (baseline established in Task 1)

## Dependencies

- Task 1 must complete before Tasks 2-3 (to know what to convert)
- Tasks 2-3 can run in parallel after Task 1
- Task 4 runs only if needed (based on findings from Tasks 2-3)
- Task 5 depends on Tasks 2-3 (CI changes after tests are ready; Task 4 is optional)
- Task 6 depends on all conversion tasks

## Execution Notes

- All conversion tasks (Tasks 2-3) should be merged into a single PR or batched together
- Each task creates code changes; PR creation happens after all conversion work is complete
- The audit in Task 1 provides the specific file list that Tasks 2-3 will convert

## Notes

- Some room tests (multi-agent flows) require real API for tool execution and cannot be converted
- Provider tests (Anthropic, OpenAI, GLM) should remain API-dependent
- Tests that verify actual AI behavior (e.g., tool selection, response quality) cannot use mock

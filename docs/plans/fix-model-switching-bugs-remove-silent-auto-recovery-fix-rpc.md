# Fix Model Switching Bugs: Remove Silent Auto-Recovery, Fix RPC Routing, DB as Source of Truth

## Goal

Fix three interrelated bugs in model switching for room agent sessions:

1. **Remove silent auto-recovery** in `query-runner.ts` — the `onStartupTimeoutAutoRecover` callback silently clears `sdkSessionId` and restarts the query, losing conversation context without user notice. Replace with fail-loud behavior: surface the error to the user and let them decide.
2. **Fix `trySwitchToFallbackModel` RPC routing** in `room-runtime.ts` — calls `messageHub.request('session.model.get', ...)` which sends the request through WebSocket transport to browser clients instead of handling it server-side. The handler is registered server-side via `onRequest()`, but `request()` always goes over the wire. Add `getCurrentModel()` to `SessionFactory` for direct server-side access.
3. **DB as single source of truth** — read current model/provider from the DB session record instead of relying on in-memory `AgentSession` cache. This avoids stale cache issues when model is switched externally.

## Approach

The three bugs share common dependencies. The plan addresses them in dependency order:

- **Milestone 1** (Bugs 2 + 3 combined): Add `getCurrentModel()` to `SessionFactory` that reads from DB as source of truth (not in-memory cache), then replace the `messageHub.request()` call in `trySwitchToFallbackModel`. Implementing DB-first from the start avoids the rework of writing a cache-first version and immediately rewriting it.
- **Milestone 2** (Bug 1): Remove silent auto-recovery. This is the most impactful change because it modifies error handling behavior. It depends on Milestone 1 so fallback model switching works correctly without silent retries.

### Key Design Decisions

1. **SessionFactory is implemented as an object literal in `createSessionFactory()`** (room-runtime-service.ts), not in SessionManager. SessionManager does NOT implement SessionFactory.
2. **`getCurrentModel()` reads from DB first, not in-memory cache.** The DB record is updated synchronously by `modelSwitchHandler.switchModel()` via `db.updateSession()`, making it the canonical source. SQLite single-row reads are sub-millisecond.
3. **Keep `messageHub` in `RoomRuntimeConfig` but remove only the `session.model.get` call.** The field is used only at the assignment and the `session.model.get` call. Removing it from the config would require updating all 19 test files that pass `messageHub` to `createRuntimeTestContext()`. Option (b) — keep the field, remove only the usage — is lower-risk.
4. **Model alias resolution in `getCurrentModel()`:** The `session.model.get` RPC handler resolves aliases via `resolveModelAlias()` before returning. The DB stores resolved model IDs after `switchModel()` (see model-switch-handler.ts where `resolvedModel = modelInfo?.id ?? newModel` is persisted). The implementer should verify whether the fallback map keys (`modelFallbackMap`) use aliases or resolved IDs, and match `getCurrentModel()` return values accordingly. If the map uses aliases, `getCurrentModel()` should return the raw DB value (which may be an alias on initial creation) without resolving. If the map uses resolved IDs, `getCurrentModel()` should resolve to match. Decision deferred to implementation with a verification step.
5. **SessionFactory consumers:** `provision-global-agent.ts` and `session-notification-sink.ts` both import and store a `SessionFactory` reference but do not call `getCurrentModel()`. Adding the method to the interface is a compile-safe change — no updates needed in those files.

---

## Milestone 1: Fix RPC Routing + DB as Source of Truth

**Goal**: Add `SessionFactory.getCurrentModel()` that reads from DB, then replace the `messageHub.request('session.model.get')` call in `room-runtime.ts`.

### Task 1.1: Add `getCurrentModel()` to `SessionFactory` interface

**Description**: Add a `getCurrentModel(sessionId: string)` method to the `SessionFactory` interface in `packages/daemon/src/lib/room/runtime/task-group-manager.ts`. Implement it in the object literal returned by `createSessionFactory()` in `packages/daemon/src/lib/room/runtime/room-runtime-service.ts`. The implementation reads from DB (source of truth), not the in-memory cache.

**Files to modify**:
- `packages/daemon/src/lib/room/runtime/task-group-manager.ts` — Add to the `SessionFactory` interface:
  ```ts
  /**
   * Get the current model and provider for a session.
   * Reads from DB as the canonical source to avoid stale in-memory cache.
   * Returns null if session is not found in DB.
   */
  getCurrentModel(sessionId: string): Promise<{ currentModel: string; currentProvider: string } | null>;
  ```
- `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` — In the object literal returned by `createSessionFactory()` (near the other method implementations), add the `getCurrentModel` implementation:
  ```ts
  getCurrentModel: async (sessionId) => {
    const session = ctx.db.getSession(sessionId);
    if (!session) return null;
    return {
      currentModel: session.config.model,
      currentProvider: session.config.provider ?? 'anthropic',
    };
  },
  ```
  The `ctx.db` closure variable is already available — it's used by `createAndStartSession` and `restoreSession` in the same object.

**Subtasks**:
1. Add the `getCurrentModel` method signature to the `SessionFactory` interface in `task-group-manager.ts`.
2. Implement `getCurrentModel` in the object literal in `room-runtime-service.ts`'s `createSessionFactory()`. Read from `ctx.db.getSession(sessionId)`.
3. Verify model alias resolution: check whether `settings.modelFallbackMap` keys use aliases (e.g., `anthropic/sonnet`) or resolved IDs (e.g., `anthropic/claude-sonnet-4-20250514`). If the map uses aliases and the DB stores resolved IDs (after `switchModel()`), the method may need to return the raw DB value. Add a comment documenting the decision.
4. **Do NOT modify** `session-manager.ts` — it does not implement `SessionFactory`.

**Acceptance criteria**:
- `SessionFactory.getCurrentModel(sessionId)` returns `{ currentModel, currentProvider }` or `null`.
- The method reads from DB, not in-memory cache.
- TypeScript compiles without errors (all files importing `SessionFactory` still work).

**Dependencies**: None

**Agent type**: coder

### Task 1.2: Replace `messageHub.request('session.model.get')` in `room-runtime.ts`

**Description**: Update `trySwitchToFallbackModel` in `packages/daemon/src/lib/room/runtime/room-runtime.ts` to call `this.sessionFactory.getCurrentModel(sessionId)` instead of `this.messageHub?.request('session.model.get', { sessionId })`.

**Files to modify**:
- `packages/daemon/src/lib/room/runtime/room-runtime.ts`:
  - In `trySwitchToFallbackModel()`, replace the `messageHub.request('session.model.get', ...)` call (the only place `this.messageHub` is used beyond the constructor assignment) with `this.sessionFactory.getCurrentModel(sessionId)`.
  - Update the destructuring: instead of `modelInfo.currentModel` and `modelInfo.modelInfo?.provider`, use `modelInfo.currentModel` and `modelInfo.currentProvider`.
  - Remove the `SessionModelGetResult` interface if no longer referenced anywhere (verify with grep first — unlikely to be imported elsewhere since it was a local type for the RPC response).
  - **Keep the `messageHub` field in `RoomRuntimeConfig`** — removing it would require updating all 19 test files that pass `messageHub` to `createRuntimeTestContext`. The risk/reward doesn't justify it.

**Subtasks**:
1. Replace the `messageHub.request('session.model.get', ...)` call with `this.sessionFactory.getCurrentModel(sessionId)`.
2. Update the return value destructuring to use the new shape (`currentProvider` instead of `modelInfo?.provider`).
3. Verify `SessionModelGetResult` has no other references; remove if safe.
4. Confirm `messageHub` is only used at the constructor assignment and the removed call; leave the field in config.

**Acceptance criteria**:
- `trySwitchToFallbackModel` no longer sends RPC requests over WebSocket for model lookup.
- `messageHub` remains in `RoomRuntimeConfig` to avoid touching 19 test files.

**Dependencies**: Task 1.1

**Agent type**: coder

### Task 1.3: Update room-runtime unit test mocks

**Description**: Update the mock `SessionFactory` and messageHub mocks across all affected test files. This task has a wider scope than initially scoped because 6 test files use `messageHub` mocks for `session.model.get`, and 5 test files use `SessionFactory`-satisfying mocks.

**Files to modify**:

*Mock factory update (SessionFactory mock — 5 files use `satisfies SessionFactory`):*
- `packages/daemon/tests/unit/room/room-runtime-test-helpers.ts` — Add `getCurrentModel` to the mock factory (`createMockSessionFactory` or equivalent):
  ```ts
  async getCurrentModel(sessionId: string) {
    return { currentModel: 'sonnet', currentProvider: 'anthropic' };
  },
  ```
  Add configurable per-session overrides via the existing options pattern.
- `packages/daemon/tests/unit/room/task-group-manager.test.ts` — Add `getCurrentModel` to any local `SessionFactory` mock if present.
- `packages/daemon/tests/unit/room/runtime-recovery.test.ts` — Add `getCurrentModel` to any local `SessionFactory` mock if present.
- `packages/daemon/tests/unit/room/room-runtime-service.test.ts` — Add `getCurrentModel` to any local `SessionFactory` mock if present.
- `packages/daemon/tests/unit/providers/codex-anthropic-bridge/server.test.ts` — Add `getCurrentModel` to any local `SessionFactory` mock if present.

*MessageHub mock simplification — 6 files mock `session.model.get` via `makeMessageHub`:*
- `packages/daemon/tests/unit/room/room-runtime-model-fallback-map.test.ts` — Has `makeMessageHub()` helper (8 occurrences). Replace with `getCurrentModel` configuration on the mock factory. Remove `makeMessageHub` helper.
- `packages/daemon/tests/unit/room/room-runtime-provider-availability.test.ts` — Has `makeMessageHub()` helper (10 occurrences). Same treatment.
- `packages/daemon/tests/unit/room/room-runtime-mirroring-usage-limit.test.ts` — Has `makeMessageHubMock()` helper (7 occurrences). Same treatment.

*Test files that pass custom messageHub mocks for `session.model.get` — verify and simplify:*
- `packages/daemon/tests/unit/room/room-runtime-terminal-errors.test.ts` — Passes `session.model.get` mock at approximately lines 448, 529. Verify if still needed after Task 1.2; if `trySwitchToFallbackModel` no longer uses messageHub, these mocks may be dead code.
- `packages/daemon/tests/unit/room/room-runtime-rate-limit-persistence.test.ts` — Passes `session.model.get` mock at approximately line 600. Same treatment.
- `packages/daemon/tests/unit/room/room-runtime-leader-terminal-errors.test.ts` — Passes `session.model.get` mock at approximately lines 271, 342, 410. Same treatment.

**Subtasks**:
1. Add `getCurrentModel` to the mock `SessionFactory` in `room-runtime-test-helpers.ts` and all 4 other files with local mocks.
2. In the 3 files with `makeMessageHub`/`makeMessageHubMock` helpers: remove the `session.model.get` mock from the messageHub mock since `trySwitchToFallbackModel` no longer uses messageHub for this. Configure `getCurrentModel` on the mock factory instead.
3. In the 3 files with inline `session.model.get` mocks: remove or simplify the mocks. If messageHub is still used in those test contexts for other purposes, keep the messageHub mock but remove the `session.model.get` handler.
4. Run all `packages/daemon/tests/unit/room/room-runtime-*.test.ts` tests to verify.

**Acceptance criteria**:
- All room-runtime unit tests pass.
- The `session.model.get` mock is removed from messageHub mocks (since the server no longer uses it).
- All files that satisfy `SessionFactory` include the `getCurrentModel` mock.

**Dependencies**: Task 1.2

**Agent type**: coder

### Task 1.4: Add unit tests for DB-as-source-of-truth behavior

**Description**: Write unit tests verifying that `getCurrentModel()` reads from the DB and reflects model switches correctly, including the full scenario of an external model switch followed by fallback chain computation.

**Files to create/modify**:
- `packages/daemon/tests/unit/room/room-runtime-model-db-source.test.ts` (new) — Tests:
  1. `getCurrentModel` returns model from DB record.
  2. After a model switch (DB update), `getCurrentModel` reflects the new model even if the in-memory cache still has the old model.
  3. `getCurrentModel` returns null for non-existent sessions.
  4. `getCurrentModel` returns default provider (`'anthropic'`) when provider is not configured.
  5. **Full fallback chain test**: Set up a session with model A, simulate an external DB update to model B, trigger `trySwitchToFallbackModel`, verify the fallback chain is computed based on model B (from DB), not model A (from in-memory cache).

**Subtasks**:
1. Create test file using `createRuntimeTestContext` with a real SQLite DB.
2. Write tests 1-4 for basic `getCurrentModel` DB behavior.
3. Write test 5 for the full external model switch → fallback chain scenario.
4. Run `make test-daemon` to verify all tests pass.

**Acceptance criteria**:
- All new tests pass.
- Tests use real DB (not mocks) to verify DB-read behavior.
- Test 5 verifies the end-to-end scenario: external DB update → correct fallback lookup.

**Dependencies**: Task 1.3

**Agent type**: coder

---

## Milestone 2: Remove Silent Auto-Recovery

**Goal**: Remove the `onStartupTimeoutAutoRecover` callback mechanism from `query-runner.ts` and `agent-session.ts`. Instead of silently retrying, surface the error immediately to the user with actionable recovery hints.

### Task 2.1: Remove auto-recovery logic from `query-runner.ts`

**Description**: Remove the entire auto-recovery code path from the catch block in `query-runner.ts`. This includes the callback, tracking field, env var constants, and the conditional retry logic.

**Files to modify**:
- `packages/daemon/src/lib/agent/query-runner.ts`:

  **Remove these items:**
  - The `onStartupTimeoutAutoRecover` optional callback in `QueryRunnerContext`.
  - The `startupTimeoutAutoRecoverAttempts` tracking field in `QueryRunnerContext`.
  - The env var functions and constants: `getStartupRecoveryDelayMs()`, `getStartupMaxRetries()`, `DEFAULT_STARTUP_RECOVERY_DELAY_MS`, `DEFAULT_STARTUP_MAX_RETRIES`, `STARTUP_RECOVERY_DELAY_MS`, `STARTUP_MAX_RETRIES`.
  - The auto-recovery guard logic in the catch block (the `canAutoRecover` branch that checks `startupRecoverAttempts <= STARTUP_MAX_RETRIES`).
  - The conditional `messageQueue.clear()` logic — after this change, always clear the queue on error.

  **Update these items:**
  - The error messages that reference `STARTUP_MAX_RETRIES + 1` (e.g., "after N attempt(s)"): simplify to remove the retry count language since there are no longer retries. The existing recovery hints ("Try sending your message again.", session-reset instructions) should be **kept**.
  - The `errorManager.handleError()` call that receives `startupMaxRetries: STARTUP_MAX_RETRIES`: remove this context property since the constant no longer exists. Verify `handleError` accepts the call without it.

  **Keep these items:**
  - The `sdkSessionId` clearing logic — still useful for the error message / fresh start on next user message.
  - The `HYPERNEO_SDK_STARTUP_TIMEOUT_MS` env var — this controls the timeout threshold, not recovery behavior.

**Subtasks**:
1. Remove `onStartupTimeoutAutoRecover` from `QueryRunnerContext`.
2. Remove `startupTimeoutAutoRecoverAttempts` from `QueryRunnerContext`.
3. Remove the env var constants and reader functions for recovery delay and max retries (`DEFAULT_STARTUP_RECOVERY_DELAY_MS`, `DEFAULT_STARTUP_MAX_RETRIES`, `STARTUP_RECOVERY_DELAY_MS`, `STARTUP_MAX_RETRIES`, `getStartupRecoveryDelayMs()`, `getStartupMaxRetries()`).
4. Simplify the catch block: remove the `canAutoRecover` branch. Always clear the message queue, always surface the error via `errorManager.handleError()`.
5. Update error messages: remove "after N attempt(s)" language. Keep recovery hints ("Try sending your message again.", session-reset instructions).
6. Remove `startupMaxRetries: STARTUP_MAX_RETRIES` from the `errorManager.handleError()` call. If `handleError` requires this property in its type, update the type to make it optional.

**Acceptance criteria**:
- No auto-recovery code path remains in `query-runner.ts`.
- Startup timeout errors are surfaced immediately to the user.
- Conversation-not-found errors are surfaced immediately.
- The error message retains actionable recovery hints ("Try sending your message again." and session-reset instructions).
- `sdkSessionId` is still cleared on startup timeout / conversation-not-found to allow fresh start on next user message.
- No references to `STARTUP_MAX_RETRIES` or `STARTUP_RECOVERY_DELAY_MS` remain.
- `errorManager.handleError()` is called without `startupMaxRetries` context.

**Dependencies**: None (can run in parallel with Milestone 1)

**Agent type**: coder

### Task 2.2: Remove auto-recovery wiring from `agent-session.ts`

**Description**: Remove the `onStartupTimeoutAutoRecover()` method implementation and the `startupTimeoutAutoRecoverAttempts` field from `agent-session.ts`.

**Files to modify**:
- `packages/daemon/src/lib/agent/agent-session.ts`:
  - Remove the `startupTimeoutAutoRecoverAttempts = 0` field.
  - Remove the `onStartupTimeoutAutoRecover()` method.
  - Find where the `QueryRunnerContext` is assembled (passed to `QueryRunner` constructor) and remove the `onStartupTimeoutAutoRecover` property.

**Subtasks**:
1. Remove `startupTimeoutAutoRecoverAttempts` field from `AgentSession`.
2. Remove `onStartupTimeoutAutoRecover()` method.
3. Remove the property from the `QueryRunnerContext` wiring.

**Acceptance criteria**:
- `AgentSession` no longer has `onStartupTimeoutAutoRecover` or `startupTimeoutAutoRecoverAttempts`.
- `QueryRunner` no longer receives these from its context.

**Dependencies**: Task 2.1

**Agent type**: coder

### Task 2.3: Update query-runner unit tests

**Description**: Update `packages/daemon/tests/unit/agent/query-runner.test.ts` to remove all auto-recovery tests and update the remaining tests.

**Files to modify**:
- `packages/daemon/tests/unit/agent/query-runner.test.ts`:
  - Remove `startupTimeoutAutoRecoverAttempts` from the test context.
  - Remove `onStartupTimeoutAutoRecover` from `createContext`.
  - Remove the entire `describe('startup timeout auto-recovery', ...)` test block (the large block covering auto-recovery scenarios).
  - Update the test "should pass actionable user message to handleError when all retries exhausted" since retries no longer exist — verify the error is surfaced on the first failure.
  - Update the test "should pass session-reset hint (no timeout mention) when conversation-not-found retries exhausted" — same treatment.
  - Add a new test: "should always call messageQueue.clear() on startup timeout".
  - Remove tests for `STARTUP_RECOVERY_DELAY_MS` and `STARTUP_MAX_RETRIES` env vars.
  - Remove the `startupMaxRetries` assertion from `handleError` call verification.

**Subtasks**:
1. Remove `onStartupTimeoutAutoRecover` and `startupTimeoutAutoRecoverAttempts` from the test context.
2. Remove all auto-recovery test cases (the large `describe` block).
3. Add test verifying immediate error surfacing on first startup timeout.
4. Add test verifying `messageQueue.clear()` is always called on startup timeout.
5. Remove env var constant tests (`STARTUP_RECOVERY_DELAY_MS`, `STARTUP_MAX_RETRIES`).
6. Update `handleError` call assertions to not expect `startupMaxRetries`.
7. Run `make test-daemon` to verify all tests pass.

**Acceptance criteria**:
- No auto-recovery test code remains.
- New tests verify that startup timeout errors are surfaced immediately on the first failure.
- `messageQueue.clear()` is always called on startup timeout.
- All daemon unit tests pass.

**Dependencies**: Task 2.1, Task 2.2

**Agent type**: coder

### Task 2.4: Online test for startup timeout error surfacing

**Description**: Add an online test verifying that a startup timeout error is surfaced to the user (via `errorManager.handleError`) without any silent retry.

**Files to create/modify**:
- `packages/daemon/tests/online/convo/startup-timeout-no-retry.test.ts` (new; since renamed to `startup-timeout-bounded-retry.test.ts` when the retry became a capped/backoff retry) — Test:
  1. Start a session and send a message.
  2. Simulate a startup timeout condition.
  3. Verify the error is surfaced immediately (no retry).
  4. Verify the error message contains actionable recovery hints.
  5. Verify the session state returns to idle after the error.

**Important implementation note**: The startup timeout duration (`HYPERNEO_SDK_STARTUP_TIMEOUT_MS`) is read at module load time in `query-runner.ts`. Setting the env var in a test after the module is loaded will have no effect. The test must use one of these approaches:
- **Option A (preferred)**: Import the daemon server fresh in the test (not from a shared module) so the env var is read after being set. Use `createDaemonServer()` which creates an isolated server instance.
- **Option B**: Inject a custom `QueryRunner` subclass or override with an artificially short timeout via a test-only mechanism.
- **Option C**: Use the dev proxy to simulate a slow SDK startup that exceeds the default timeout.

The implementer should choose the approach that works reliably with the existing test infrastructure.

**Subtasks**:
1. Create the test file using the existing online test patterns (`createDaemonServer` with dev proxy).
2. Trigger a startup timeout condition using one of the approaches above.
3. Verify error is surfaced via `errorManager.handleError` without any retry.
4. Verify the error message contains recovery hints.
5. Clean up the session after the test.

**Acceptance criteria**:
- The test verifies no retry occurs.
- The error is surfaced via `errorManager.handleError`.
- The test passes with `HYPERNEO_USE_DEV_PROXY=1`.

**Dependencies**: Task 2.3

**Agent type**: coder

---

## Summary

| Milestone | Task | Description | Dependencies |
|-----------|------|-------------|-------------|
| 1 | 1.1 | Add `getCurrentModel()` to `SessionFactory` interface (DB-first) | None |
| 1 | 1.2 | Replace `messageHub.request()` in `room-runtime.ts` | 1.1 |
| 1 | 1.3 | Update room-runtime unit test mocks (5 factory files + 6 messageHub files) | 1.2 |
| 1 | 1.4 | Add unit tests for DB-as-source-of-truth + external switch scenario | 1.3 |
| 2 | 2.1 | Remove auto-recovery logic from `query-runner.ts` | None |
| 2 | 2.2 | Remove auto-recovery wiring from `agent-session.ts` | 2.1 |
| 2 | 2.3 | Update query-runner unit tests | 2.1, 2.2 |
| 2 | 2.4 | Online test for startup timeout error surfacing | 2.3 |

**Total tasks**: 8 (down from 9 — Milestones 1 and 2 of the original plan merged)
**Milestone 1 and Milestone 2 can run in parallel** (no cross-dependencies).

## Risks and Edge Cases

1. **Model alias resolution mismatch with fallback map**: The DB stores resolved model IDs after `switchModel()`, but the user-configured `modelFallbackMap` may use aliases. If `getCurrentModel()` returns a resolved ID from DB but the map key is an alias, the fallback lookup will miss. The implementer must verify which format the map uses and adjust accordingly. This is a pre-existing issue that the plan does not introduce but should document.

2. **DB read latency**: Reading from DB on every `getCurrentModel()` call adds latency vs. in-memory cache. Mitigation: SQLite single-row reads are sub-millisecond; this is negligible compared to an RPC round-trip over WebSocket.

3. **`messageHub` still in config**: Keeping `messageHub` in `RoomRuntimeConfig` means the unused reference at the assignment remains. This is acceptable — the risk of removing it (touching 19 test files) outweighs the benefit of removing a single unused field.

4. **Backward compatibility for `HYPERNEO_SDK_STARTUP_RECOVERY_DELAY_MS` and `HYPERNEO_SDK_STARTUP_MAX_RETRIES`**: These env vars will no longer have any effect after Milestone 2. This is acceptable because they were undocumented debugging knobs. The `HYPERNEO_SDK_STARTUP_TIMEOUT_MS` env var is kept. (Update, 2026-08-16: the retirement still holds — `HYPERNEO_SDK_STARTUP_MAX_RETRIES` remains dead. The later startup-timeout backoff/cap work deliberately chose the distinct name `HYPERNEO_SDK_STARTUP_RETRY_MAX` so a stale setting from this system cannot silently change the new cap.)

5. **Online test reliability**: The startup timeout test (Task 2.4) depends on being able to trigger a timeout condition reliably. The module-level env var loading makes this tricky. The implementation note provides three approaches; the implementer should choose the one that works best.

## Testing Strategy

- **Unit tests**: Existing room-runtime tests (19 files) and query-runner tests provide comprehensive coverage. All must pass after changes.
- **New unit tests**: Task 1.4 adds DB-source-of-truth tests including the external model switch → fallback scenario. Task 2.3 adds immediate-error-surfacing tests.
- **Online tests**: Task 2.4 adds an online test for startup timeout behavior using the dev proxy.
- **E2E tests**: Not required for this change — the bugs are server-side and do not affect the UI directly. The UI already handles error messages via `errorManager.handleError()`.

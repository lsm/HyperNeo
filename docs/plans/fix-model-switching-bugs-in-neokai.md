# Fix Model Switching Bugs in HyperNeo

## Goal Summary

Fix two model switching bugs that prevent model changes from taking effect:

1. **Bug 1 (Task View)**: When switching models in the Task View, `session.model.switch` creates a NEW `AgentSession` via `SessionCache` (a separate instance from `RoomRuntimeService.agentSessions`), causing duplicate/conflicting concurrent queries for the same session.
2. **Bug 2 (Normal Session)**: When switching models on a normal session, the agent may stop responding or may not use the new model. Root cause is unverified — an investigation task (Task 1) will determine whether the issue actually exists and what fix is needed.

## Approach

### Bug 1 Fix: Register room sessions in SessionCache (matching Space pattern)

The root cause is that `session.model.switch` RPC handler in `session-handlers.ts` calls `sessionManager.getSessionAsync(sessionId)`, which for room worker/leader sessions creates a brand new `AgentSession` from DB via `SessionCache.loadSessionAsync()` -- because those sessions live in `RoomRuntimeService.agentSessions`, not in `SessionManager.sessionCache`.

**Why `registerSession` over new RPC handlers**: Space sessions (via `TaskAgentManager`) already solve this exact problem by calling `sessionManager.registerSession()` after creating sessions via `AgentSession.fromInit()`. The `SessionCache.set()` method clears any pending load locks so new `getAsync()` callers immediately see the registered instance, and `getAsync()` has a guard that prefers the registered live instance over a DB-loaded duplicate. This approach:
- Fixes the bug for **all** RPC handlers that use `sessionManager.getSessionAsync()` (not just model switching -- also `message.send`, `message.sdkMessages`, etc.)
- Requires **zero** new RPC handlers, no new RPC method names, no UI changes
- Is consistent with the existing Space architecture (`task-agent-manager.ts:398`)

**Fix — two registration paths**: Room sessions enter `RoomRuntimeService.agentSessions` through two distinct code paths, both of which must register in `SessionCache`:

1. **New session creation** (`createAndStartSession` at line 272): After `agentSessions.set(init.sessionId, session)` (line 281), call `ctx.sessionManager.registerSession(session)`.

2. **Session restoration after daemon restart** (`restoreSession` at line 398): After `agentSessions.set(sessionId, session)` (line 411), call `ctx.sessionManager.registerSession(session)`. This is critical -- without it, the fix would only work until the first daemon restart.

**Cleanup — all teardown paths**: Room sessions are removed from `agentSessions` through multiple code paths, each of which must unregister from `SessionCache`:

1. **`stopSession()`** (line 458, `finally` block): Called during task cancellation/completion. After `agentSessions.delete(sessionId)` (line 473), add `ctx.sessionManager.unregisterSession(sessionId)`.

2. **`RoomRuntimeService.stop()`** (line 228): Called during daemon shutdown. Before `this.agentSessions.clear()` (line 234), iterate all entries and call `ctx.sessionManager.unregisterSession()` for each.

**Why add `unregisterSession` to `SessionManager`**: `SessionManager.sessionCache` is `private`. Adding `unregisterSession(sessionId: string): void` as a thin wrapper over `this.sessionCache.remove(sessionId)` mirrors the existing `registerSession()` which wraps `this.sessionCache.set()`, maintaining API symmetry.

**Race condition in `SessionCache.remove()`**: The current `remove()` method (line 141-143 of `session-cache.ts`) only calls `this.sessions.delete(sessionId)` but does **NOT** clear `this.sessionLoadLocks`. This creates a race: if a concurrent `getAsync()` call has already passed the `sessions.has()` check and is awaiting an in-flight load lock, the load will eventually resolve, check `if (!this.sessions.has(sessionId))` → true (since we just removed it), and re-insert a stale DB-loaded duplicate into the cache. The fix must also clear the load lock in `remove()`, mirroring how `set()` clears it (line 135). Since `SessionCache` is a private dependency of `SessionManager`, the implementer should update `SessionCache.remove()` to also call `this.sessionLoadLocks.delete(sessionId)`. Existing callers of `sessionCache.remove()` (in `SessionLifecycle.delete()`) will benefit from this fix as well.

**Space session collision risk**: Space session IDs use the `space:{uuid}:task:{uuid}` prefix, while Room session IDs use `{role}:{roomId}:{taskId}:{uuid}` or `room:chat:{roomId}`. These are structurally disjoint namespaces, making a collision practically impossible. `SessionCache.set()` has no overwrite guard, but the disjoint namespaces make this moot. No additional guard is needed.

**Namespace invariant**: The disjoint namespace guarantee relies on an invariant that must be preserved: **room role strings (e.g., `coder`, `general`, `planner`, `leader`) must never equal the literal string `"space"`**. If a role named `"space"` were introduced, session IDs like `space:{roomId}:...` could collide with Space session IDs like `space:{spaceId}:task:{taskId}`. This constraint should be documented in the role definition code (where roles are defined/enumerated) to prevent future violations.

### Bug 2: Investigation — does model switching actually work?

**Observation**: Model switching worked before without forking. The original root-cause analysis assumed the SDK uses a stale model from the session file, but the model is NOT stored in the session file — `.jsonl` files contain only messages. The SDK receives `--model` and `--resume` as CLI flags and should honor the new model.

**Uncertainty**: The previous plan proposed using `forkSession: true` to work around potential stale state, but this was never verified. We need concrete evidence before committing to any fix approach.

**Approach**: Write an online integration test (using dev proxy) that performs a model switch mid-session and observes the `system:init` message from the SDK subprocess. The `system:init` message's `model` field is the authoritative source for which model the SDK is actually using. By comparing the `model` field before and after the switch, we can determine whether the new model takes effect.

**Observability mechanism**: Subscribe to `state.sdkMessages.delta` events on the session channel via `daemon.messageHub.onEvent()`. Listen for `type === 'system' && subtype === 'init'` messages and read the `.model` field. Use the `waitForSystemInit()` helper pattern from `packages/daemon/tests/online/coordinator/coordinator-mode-switch.test.ts` (lines 54-97), which joins the session channel via `daemon.messageHub.joinChannel('session:' + sessionId)`, parses the `added` array from the delta payload, and matches on `msg.type === 'system' && msg.subtype === 'init'`. Adapt this helper to also extract and return the `model` field.

**Decision point**: After this investigation task completes, the human reviewer will decide the Bug 2 approach based on the evidence:
- **If the test passes** (new model appears in `system:init` after switch): model switching works without forking — the bug may be elsewhere (e.g., UI-only, race condition in restart, or already fixed). No `forkSession` implementation needed.
- **If the test fails** (old model still appears in `system:init`): we have concrete proof of the issue, and can investigate further (forkSession, clearing sdkSessionId, or other approaches).

---

## Tasks

### Task 1: Investigate whether model switching takes effect without code changes (Bug 2)

**Description**: Write an online integration test that performs a model switch mid-session and observes the SDK's `system:init` message to verify whether the new model actually takes effect. This task produces evidence to guide the Bug 2 fix approach — it does NOT implement any fix.

**File**: `packages/daemon/tests/online/rpc/rpc-model-switching.test.ts` (append to existing file)

**Key observability mechanism**: The SDK's `system:init` message (first message emitted by a new query) carries a `model` field that is the authoritative source for which model the subprocess is using. By subscribing to `state.sdkMessages.delta` events on the session channel and listening for `system:init` messages before and after the switch, we can determine whether the new model takes effect. Use the `waitForSystemInit()` helper pattern from `packages/daemon/tests/online/coordinator/coordinator-mode-switch.test.ts` (lines 54-97) — it uses `daemon.messageHub.onEvent('state.sdkMessages.delta', ...)` and `daemon.messageHub.joinChannel(...)`, which is the modern API (the old raw WebSocket `SUBSCRIBE` pattern in `agent-session-sdk.test.ts` is inside a `describe.skip` block marked "DEPRECATED").

**Subtasks**:
1. Create a `waitForSystemInit(sessionId)` helper adapted from `packages/daemon/tests/online/coordinator/coordinator-mode-switch.test.ts` (lines 54-97). It should:
   - Join the session channel via `daemon.messageHub.joinChannel('session:' + sessionId)`
   - Return a Promise that resolves with the `model` field from the next `system:init` delta event
   - Listen via `daemon.messageHub.onEvent('state.sdkMessages.delta', ...)` and parse the `added` array
   - Match on `msg.type === 'system' && msg.subtype === 'init'`
   - Clean up the event listener after resolving

2. Write a test (using dev proxy via `NEOKAI_USE_DEV_PROXY=1`) that:
   - Creates a session and sends a message to start a query.
   - **Before sending**: call `waitForSystemInit(sessionId)` to capture the initial `model` field → `initialModel`. Wait for the query response to confirm the agent is working.
   - Calls `session.model.switch` with a different model (e.g., `claude-sonnet-4-20250514` → `claude-haiku-4-5-20251001`) and awaits completion. The `restart()` happens internally — the RPC returns after the old query is stopped.
   - **After the RPC returns, before sending the next message**: call `waitForSystemInit(sessionId)` to capture the post-switch `model` field → `postSwitchModel`. Do NOT subscribe before the RPC call — `restart()` may emit teardown-related events that could race with the subscription. The subscription must be set up after the RPC completes but before the post-switch message triggers a new query turn.
   - Sends another message (this triggers the new query turn, which emits the `system:init` that `waitForSystemInit` is waiting for).
   - Asserts that `postSwitchModel !== initialModel` (the SDK subprocess is using the new model).
   - Waits for the response (verifying the agent is not stuck after the switch).

3. If the dev proxy does not support observing different models (it mocks all responses uniformly), the test can still verify that a NEW `system:init` is emitted after the switch (the `session_id` may or may not change). Document the limitation clearly.

4. Run the test and record the results. The test outcome determines next steps:
   - **Pass**: Model switching works — the SDK honors `--model` even when `--resume` is set. Bug 2 may not exist as described, or the fix may be simpler than `forkSession`.
   - **Fail**: The SDK uses the old model after a switch → we have proof that forking or another approach is needed.

**Dev proxy considerations**: The dev proxy mock system does NOT distinguish between models — all requests get the same mock response regardless of the `model` field. The `system:init` message's `model` field is emitted by the SDK subprocess BEFORE any API request, so it reflects the CLI flag, not the mock response. The test should still be able to observe the model field from `system:init` even with dev proxy.

**Acceptance criteria**:
- Test produces a clear pass/fail result.
- The `system:init` `model` field is captured before and after the switch.
- Results are documented (pass → model switching works; fail → `forkSession` or alternative approach needed).
- Test passes with `NEOKAI_USE_DEV_PROXY=1`.

**Dependencies**: None

**Agent type**: coder

---

> **Decision point**: After Task 1 completes, the human reviewer will decide the Bug 2 approach based on the evidence. If the test shows model switching already works, no further Bug 2 tasks are needed. If it fails, a new task will be created with the appropriate fix (possibly `forkSession: true`, clearing `sdkSessionId`, or another approach).

---

### Task 2: Add `unregisterSession` to SessionManager and register room sessions in SessionCache (Bug 1)

**Description**: Add `unregisterSession()` to `SessionManager` for symmetry with the existing `registerSession()`, then register room worker/leader sessions in `SessionCache` through both creation paths and unregister them through all teardown paths.

**Files**:
- `packages/daemon/src/lib/session/session-cache.ts` — fix `remove()` to also clear `sessionLoadLocks`
- `packages/daemon/src/lib/session/session-manager.ts` — add `unregisterSession()` method
- `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` — add `registerSession` in `createAndStartSession()` AND `restoreSession()`, add `unregisterSession` in `stopSession()` and `stop()`

**Subtasks**:

0. **Fix `SessionCache.remove()` race condition**: In `session-cache.ts`, update the `remove()` method (line 141) to also clear the session load lock:
   ```ts
   remove(sessionId: string): void {
       this.sessions.delete(sessionId);
       this.sessionLoadLocks.delete(sessionId);
   }
   ```
   This mirrors `set()` (line 132-136) which already clears `sessionLoadLocks`. Without this fix, a concurrent `getAsync()` call awaiting a load lock would re-insert a stale DB-loaded duplicate after `remove()` deletes the session from `sessions`. Existing callers of `sessionCache.remove()` (e.g., `SessionLifecycle.delete()`) will also benefit from this fix.

1. Add `unregisterSession(sessionId: string): void` to `SessionManager` that delegates to `this.sessionCache.remove(sessionId)`. This mirrors `registerSession()` which delegates to `this.sessionCache.set()`.

2. **Registration path 1 — new session creation**: In `createSessionFactory().createAndStartSession()` (line 272), after `agentSessions.set(init.sessionId, session)` (line 281), add:
   ```ts
   ctx.sessionManager.registerSession(session);
   ```

3. **Registration path 2 — daemon restart restoration**: In `createSessionFactory().restoreSession()` (line 398), after `agentSessions.set(sessionId, session)` (line 411), add:
   ```ts
   ctx.sessionManager.registerSession(session);
   ```
   This is critical. Without this, sessions restored after a daemon restart would NOT be in SessionCache, and Bug 1 would reoccur on every restart. The `restoreSession()` path uses `AgentSession.restore()` instead of `AgentSession.fromInit()`, but the result is the same `AgentSession` instance that needs to be findable via `sessionManager.getSessionAsync()`.

4. **Teardown path 1 — individual session stop**: In `stopSession()` (line 458, in the `finally` block after `agentSessions.delete(sessionId)` at line 473), add:
   ```ts
   ctx.sessionManager.unregisterSession(sessionId);
   ```

5. **Teardown path 2 — service shutdown**: In `RoomRuntimeService.stop()` (line 228), before `this.agentSessions.clear()` (line 234), iterate all entries and unregister each:
   ```ts
   for (const sessionId of this.agentSessions.keys()) {
       ctx.sessionManager.unregisterSession(sessionId);
   }
   this.agentSessions.clear();
   ```
   This prevents stale room session references from remaining in SessionCache after daemon shutdown.

6. Verify that the `SessionCache.getAsync()` guard (line 99 of `session-cache.ts`) correctly prefers the registered instance if a concurrent `getAsync()` call is in-flight during registration.
7. Document the namespace invariant: room role strings must never equal `"space"` (add a comment in the role definition code where roles are enumerated).

**Acceptance criteria**:
- `SessionCache.remove()` also clears `sessionLoadLocks` for the removed session ID (preventing concurrent `getAsync()` from re-inserting a stale duplicate).
- `SessionManager.unregisterSession()` is available and delegates to `sessionCache.remove()`.
- Room sessions are registered in `SessionCache` immediately after creation via `createAndStartSession()`.
- Room sessions are registered in `SessionCache` after restoration via `restoreSession()` (daemon restart path).
- Room sessions are unregistered from `SessionCache` when stopped via `stopSession()`.
- Room sessions are unregistered from `SessionCache` when the service shuts down via `stop()`.
- `sessionManager.getSessionAsync()` for a room session returns the live instance (same object reference as in `RoomRuntimeService.agentSessions`), not a DB-loaded duplicate.
- No duplicate `AgentSession` is created for room sessions when `session.model.switch` or any other RPC handler calls `getSessionAsync()`.
- Existing Space session tests still pass (no regression -- Space and Room session IDs use disjoint namespaces: `space:{uuid}:task:{uuid}` vs `{role}:{roomId}:{taskId}:{uuid}`).

**Dependencies**: None

**Agent type**: coder

---

### Task 3: Add unit tests for room session registration in SessionCache (Bug 1 tests)

**Description**: Add unit tests to verify that room sessions are properly registered/unregistered in SessionCache, covering both creation and restoration paths.

**File**: `packages/daemon/tests/unit/room/` (new test file or append to existing room test file)

**Subtasks**:
1. Test that `SessionManager.unregisterSession()` calls `sessionCache.remove()` with the correct session ID.
2. Test that `SessionCache.remove()` also clears `sessionLoadLocks` for the removed session ID.
3. Test the unregister race condition: if `getAsync()` has an in-flight load lock, and `remove()` is called concurrently, the load lock is cleared so the in-flight load does NOT re-insert a stale session into `sessions`.
4. Test that after `registerSession()` is called, `getSessionAsync()` returns the registered instance (not a DB-loaded duplicate).
5. Test that after `unregisterSession()` is called, `getSessionAsync()` falls through to DB loading (the session is no longer in cache).
6. Test the concurrent access guard: if `getAsync()` is called concurrently with `registerSession()`, the registered instance is preferred over the DB-loaded one (this tests the guard at `session-cache.ts:100`).
7. Test that restoring a session (simulating `restoreSession()` flow) also registers it in SessionCache.
8. If possible, add an integration test that simulates room session creation via `createAndStartSession()` and verifies the session is findable via `sessionManager.getSessionAsync()`.

**Acceptance criteria**:
- All tests pass.
- `unregisterSession` correctly removes from cache.
- Registered instances are returned by `getSessionAsync()`.
- Concurrent access guard works correctly.
- Restore path also registers sessions.
- No regression in existing SessionCache tests.

**Dependencies**: Task 2

**Agent type**: coder


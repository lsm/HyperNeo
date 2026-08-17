/**
 * Startup Timeout — Bounded Retry Behavior Test
 *
 * Verifies that when the SDK startup times out:
 *   1. The system retries automatically up to the per-delivery cap (pinned to
 *      1 here via HYPERNEO_SDK_STARTUP_RETRY_MAX).
 *   2. The session eventually reaches idle (no infinite loop).
 *   3. If the retry also fails, the error has actionable recovery hints.
 *   4. If the retry succeeds, no error is surfaced (the retry fixed it).
 *
 * Implementation note — module-level constant:
 *   STARTUP_TIMEOUT_MS in query-runner.ts is read once at process start, so it
 *   cannot be changed by mutating process.env after the process is running.
 *   This test forces DAEMON_TEST_SPAWN=true so a fresh child process loads the
 *   module with the env var already set to a very short value (10 ms). The SDK
 *   subprocess cannot respond within 10 ms, so the startup timer fires on the
 *   first attempt; the retry spawns a fresh subprocess that also cannot respond
 *   in time. assertBoundedRetrySequenceRan() verifies the timeout fired on BOTH
 *   attempts and the retry branch ran exactly once — otherwise the suite
 *   could pass vacuously if the SDK ever responded within the window. Under the
 *   forced 10 ms both attempts time out, so the retry always fails; Test 1
 *   asserts the terminal startup-timeout error is present (not absent).
 *
 *   The retry backoff base (HYPERNEO_SDK_STARTUP_RETRY_BASE_MS) is zeroed for
 *   the child so the retry fires immediately instead of sleeping 15 s; the
 *   backoff schedule itself is covered by unit tests.
 *
 * MODES:
 *   - Dev Proxy (preferred, offline): HYPERNEO_USE_DEV_PROXY=1
 *   - Real API: requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 *
 * Run:
 *   cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/convo/startup-timeout-bounded-retry.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { getProcessingState } from '../../helpers/daemon-actions';

const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;
// Spawned daemon startup is slower than in-process; allow extra time.
// SETUP_TIMEOUT must exceed the aggregate inner budgets so the hook doesn't
// time out mid-startup (leaving the child + dev-proxy lease alive): the spawned
// server's port-startup timeout (20 s) + waitForModelsReady (MODELS_READY_TIMEOUT_MS)
// + WebSocket init / cleanup. The dev proxy is reused across the run
// (sharedDevProxyController singleton), but the FIRST beforeEach still pays its
// startup (~10-15 s), so the budget must cover that too on a slow runner — the
// worst-case aggregate (~65 s) exceeds the previous 60 s mock ceiling. The values
// below leave headroom over that aggregate.
const SETUP_TIMEOUT = IS_MOCK ? 75000 : 90000;
const TEST_TIMEOUT = IS_MOCK ? 60000 : 90000;
const IDLE_TIMEOUT = IS_MOCK ? 45000 : 60000;
// Extra readiness budget for createDaemonServer: the thrashed subprocess spawns
// delay the daemon's model fetch beyond the helper's 8 s default.
const MODELS_READY_TIMEOUT_MS = IS_MOCK ? 25000 : 30000;

// Small enough that the startup timer fires before the SDK emits its first
// message. Against the dev proxy the SDK's first message (system:init) arrives
// within tens of ms, so 100 ms does NOT fire (verified — the test passed
// vacuously). 10 ms reliably fires on every machine we run on. The resulting
// subprocess abort/respawn churn is absorbed by the generous wait budgets and
// modelsReadyTimeoutMs above, and assertBoundedRetrySequenceRan() fails the test
// outright if the timeout ever stops firing (no silent vacuous pass).
const FORCED_STARTUP_TIMEOUT_MS = '10';

/**
 * Read the current session error directly from the `state.session` RPC.
 * Returns null if no error is set.
 */
async function getSessionError(
  daemon: DaemonServerContext,
  sessionId: string,
  timeoutMs?: number
): Promise<{ message: string; details?: unknown } | null> {
  const state = (await daemon.messageHub.request(
    'state.session',
    { sessionId },
    { timeout: timeoutMs }
  )) as { error?: { message: string; details?: unknown } | null };
  return state.error ?? null;
}

/**
 * Wait until the daemon's startup-timeout TIMER callback has logged
 * "SDK startup timeout:" (the startup timer callback in query-runner.ts) at least
 * `expected` times.
 *
 * Why this is needed: the retry branch tears down the timed-out subprocess
 * (waits up to RETRY_EXIT_TIMEOUT_MS = 5 s for its exit) before running the
 * recursive retry, and the session STAYS 'processing' through that window (the
 * retry no longer idles mid-chain), so a state-based wait cannot observe the
 * retry's second attempt starting. Polling the captured output for
 * the second timer log makes the test actually wait for the retry's second
 * attempt. Requires the daemon spawned with LOG_LEVEL=warn (it is SILENT under
 * NODE_ENV=test by default).
 *
 * Counts "SDK startup timeout:" (colon) specifically — the catch block separately
 * logs "SDK startup timeout - query aborted" (dash), which must not be counted.
 */
async function waitForStartupTimeoutTimer(
  daemon: DaemonServerContext,
  expected: number,
  timeoutMs: number
): Promise<void> {
  const countTimers = () =>
    (daemon.getCapturedOutput?.() ?? '').split('SDK startup timeout:').length - 1;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countTimers() >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `expected >= ${expected} "SDK startup timeout:" timer log(s); saw ${countTimers()} ` +
      '(the bounded-retry sequence did not complete — the retry attempt never timed out)'
  );
}

/**
 * Assert the startup-timeout timer fired on BOTH attempts (2 timer logs) and the
 * capped retry branch ran exactly once (1 retry log). Call AFTER
 * waitForStartupTimeoutTimer(daemon, 2, …) so the second attempt has actually
 * been observed. Uses the timer-callback-specific "SDK startup timeout:" text so
 * the catch block's "SDK startup timeout - query aborted" line is not counted.
 */
function assertBoundedRetrySequenceRan(daemon: DaemonServerContext): void {
  const output = daemon.getCapturedOutput?.() ?? '';
  const timers = output.split('SDK startup timeout:').length - 1;
  const retries = output.split('Auto-retrying query after startup timeout').length - 1;
  expect(
    timers,
    `expected 2 startup-timeout timer logs (attempt 1 + the retry's attempt 2); got ${timers}`
  ).toBe(2);
  expect(
    retries,
    `expected the bounded retry branch to run exactly once; got ${retries} retry log(s)`
  ).toBe(1);
}

/**
 * Wait until the daemon has set the TERMINAL session error (errorManager →
 * state.session.error), polling the `state.session` RPC at a 100 ms tick.
 *
 * Why this — not waitForIdle — gates the post-retry assertions: the session
 * stays 'processing' throughout the backoff window and attempt 2 (setProcessing
 * is only re-asserted when an SDK message arrives, which never happens because
 * attempt 2 times out first), and waitForIdle would then need to span the FULL
 * bounded-retry sequence (both 10 ms windows + teardown + backoff) with no
 * signal that the terminal handleError has actually run — afterEach's SIGTERM
 * could tear the daemon down before handleError sets the error (isCleaningUp()
 * early-returns). Polling for the error directly is the only signal that
 * attempt 2's terminal handling has run. Under the forced 10 ms both attempts
 * time out, so the terminal error always appears.
 */
async function waitForSessionError(
  daemon: DaemonServerContext,
  sessionId: string,
  timeoutMs: number
): Promise<{ message: string; details?: unknown }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Bound each poll's RPC to the remaining budget (cap 2 s) so a slow daemon
    // can't overrun the shared deadline by MessageHub's default 10 s, and retry
    // transient RPC failures (e.g. the daemon busy during abort-driven cleanup)
    // instead of letting one abort the whole poll. Clamp to >= 1 ms: if the
    // deadline elapses between the loop guard and this Date.now(), a 0 would be
    // falsy in `options.timeout || defaultTimeout` and silently become the 10 s
    // default — re-opening the overrun.
    const rpcTimeout = Math.min(2000, Math.max(1, deadline - Date.now()));
    try {
      const error = await getSessionError(daemon, sessionId, rpcTimeout);
      if (error) return error;
    } catch {
      // Transient RPC failure — keep polling until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `expected a terminal session error within ${timeoutMs}ms — attempt 2's ` +
      'handleError did not set one (the daemon was likely torn down before it ran)'
  );
}

/**
 * Wait for the bounded-retry sequence to fully complete: both attempts' startup
 * timers fired (the retry ran AND attempt 2 timed out) AND attempt 2's terminal
 * handleError has set the session error. See waitForStartupTimeoutTimer for
 * stage 1 (proves the retry happened) and waitForSessionError for stage 2 (the
 * terminal signal — waitForIdle cannot serve that role here, see its docstring).
 *
 * Both stages share ONE deadline (IDLE_TIMEOUT), not a budget each — otherwise
 * a slow abort-driven cleanup could consume IDLE_TIMEOUT in stage 1 and again
 * in stage 2, exceeding the enclosing TEST_TIMEOUT. Each stage resolves in a
 * few seconds in practice; the shared deadline only bounds the worst case.
 */
async function waitForBoundedRetryCompleted(
  daemon: DaemonServerContext,
  sessionId: string
): Promise<void> {
  const deadline = Date.now() + IDLE_TIMEOUT;
  const remaining = (): number => Math.max(0, deadline - Date.now());
  await waitForStartupTimeoutTimer(daemon, 2, remaining());
  await waitForSessionError(daemon, sessionId, remaining());
}

describe('Startup Timeout Error Surfacing', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    // STARTUP_TIMEOUT_MS is a module-level constant in query-runner.ts — it is
    // captured once when the process starts.  We must spawn a fresh child
    // process so the env var is read at its module-load time. The retry knobs
    // are read lazily but still need to reach the child via its spawn env.
    const origSpawn = process.env.DAEMON_TEST_SPAWN;
    const origTimeout = process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
    const origRetryBase = process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS;
    const origMaxRetries = process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX;

    process.env.DAEMON_TEST_SPAWN = 'true';
    process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = FORCED_STARTUP_TIMEOUT_MS;
    // Zero the backoff so the retry fires immediately (the default 15 s base
    // would stall the test), and pin the cap to 1 to keep the two-attempt
    // shape of the assertions below.
    process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '0';
    process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '1';

    try {
      daemon = await createDaemonServer({
        modelsReadyTimeoutMs: MODELS_READY_TIMEOUT_MS,
        // Surface warn-level daemon logs in the captured child output:
        //   - error "SDK startup timeout"  (startup timer callback fired)
        //   - warn  "Auto-retrying query after startup timeout" (retry ran — :990)
        // The daemon Logger is SILENT under NODE_ENV=test by default, so LOG_LEVEL
        // must override it for these assertions to observe anything.
        env: { LOG_LEVEL: 'warn' },
      });
    } finally {
      // Restore parent-process env vars immediately; the child process has
      // already captured its own copy of the env at spawn time.
      if (origSpawn === undefined) {
        delete process.env.DAEMON_TEST_SPAWN;
      } else {
        process.env.DAEMON_TEST_SPAWN = origSpawn;
      }
      if (origTimeout === undefined) {
        delete process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
      } else {
        process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = origTimeout;
      }
      if (origRetryBase === undefined) {
        delete process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS;
      } else {
        process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = origRetryBase;
      }
      if (origMaxRetries === undefined) {
        delete process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX;
      } else {
        process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = origMaxRetries;
      }
    }
  }, SETUP_TIMEOUT);

  afterEach(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, SETUP_TIMEOUT);

  test(
    'should reach idle after startup timeout (retry may or may not succeed)',
    async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: process.cwd(),
        title: 'Startup Timeout Test',
        config: {
          model: 'haiku',
          permissionMode: 'acceptEdits',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      const errorEvents: Array<{ message: string }> = [];
      await daemon.messageHub.joinChannel(`session:${sessionId}`);

      const unsubscribe = daemon.messageHub.onEvent('state.session', (data: unknown) => {
        const state = data as {
          sessionInfo?: { id?: string };
          error?: { message: string } | null;
        };
        if (state.sessionInfo?.id !== sessionId) return;
        if (state.error) {
          errorEvents.push({ message: state.error.message });
        }
      });

      try {
        // Send a message — this kicks off query-runner.ts with STARTUP_TIMEOUT_MS
        // set to FORCED_STARTUP_TIMEOUT_MS. The SDK subprocess cannot respond that
        // fast, so the startup timer fires and the system retries once automatically.
        // The retry spawns a fresh subprocess and may succeed or fail on timing.
        await daemon.messageHub.request('message.send', {
          sessionId,
          content: 'Hello, please respond.',
        });

        // ── Wait for the bounded-retry sequence to fully complete: both attempts'
        //    timers fired AND attempt 2's terminal handleError has set the error.
        //    The 2nd timer log alone doesn't suffice — it fires before the
        //    terminal handleError, and without waiting for the error, afterEach's
        //    SIGTERM can tear the daemon down before handleError runs. See
        //    waitForBoundedRetryCompleted / waitForSessionError.
        await waitForBoundedRetryCompleted(daemon, sessionId);

        // ── Assertion 1: the startup timeout fired on BOTH attempts and the
        //    capped retry branch ran exactly once (no vacuous pass, no skipped
        //    retry). ───────────────────────────────────────────────────────────────
        assertBoundedRetrySequenceRan(daemon);

        // ── Assertion 2: session reaches terminal idle (no infinite loop) ───────
        const finalState = await getProcessingState(daemon, sessionId);
        expect(finalState.status).toBe('idle');

        // ── Assertion 3: both attempts timed out (2 timer logs above), so the
        //    retry FAILED — the session MUST carry a startup-timeout error with
        //    actionable hints. Accepting null would mask a transient pre-
        //    handleError read; waitForBoundedRetryCompleted guarantees handleError ran.
        const sessionError = await getSessionError(daemon, sessionId);
        expect(
          sessionError,
          'expected a startup-timeout error after both attempts failed'
        ).not.toBeNull();
        const errorMsg = sessionError!.message;
        expect(errorMsg).toContain('failed to start');
        // Corrected hint (2026-08-16 incident): names the silent subprocess and
        // concurrent-start load — not workspace/lock-file contention.
        expect(errorMsg).toContain('did not produce its first message');
        expect(errorMsg).toContain('too many sessions starting at the same time');
        expect(errorMsg).not.toContain('stale lock file');
        expect(errorMsg).toContain('HYPERNEO_SDK_STARTUP_TIMEOUT_MS');
        // The hint must print the EFFECTIVE value, not just the variable name —
        // this run forces 10ms via FORCED_STARTUP_TIMEOUT_MS, pinning the
        // override path (the 60s default is pinned in query-runner.test.ts).
        expect(errorMsg).toContain('current: 10ms');
      } finally {
        unsubscribe();
      }
    },
    TEST_TIMEOUT
  );

  test(
    'should not retry more than once (bounded error count)',
    async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: process.cwd(),
        title: 'Bounded Retry Test',
        config: {
          model: 'haiku',
          permissionMode: 'acceptEdits',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      // Track every error event emitted during the query lifetime.
      const errorEvents: Array<{ message: string }> = [];
      await daemon.messageHub.joinChannel(`session:${sessionId}`);

      const unsubscribe = daemon.messageHub.onEvent('state.session', (data: unknown) => {
        const state = data as {
          sessionInfo?: { id?: string };
          error?: { message: string } | null;
        };
        if (state.sessionInfo?.id !== sessionId) return;
        if (state.error) {
          errorEvents.push({ message: state.error.message });
        }
      });

      try {
        await daemon.messageHub.request('message.send', {
          sessionId,
          content: 'Say hi.',
        });

        // ── Wait for the bounded-retry sequence to fully complete before asserting
        //    (both timers fired + attempt 2's terminal handleError). See
        //    waitForBoundedRetryCompleted — neither waitForIdle nor the 2nd timer
        //    log alone reaches attempt 2's terminal state.
        await waitForBoundedRetryCompleted(daemon, sessionId);

        // ── Assertion 1: the startup timeout fired on BOTH attempts and retried
        //    EXACTLY once — directly proves "not more than once" and that the
        //    retry's second attempt actually ran. ────────────────────────────────
        assertBoundedRetrySequenceRan(daemon);

        // ── Assertion 2: session is terminal idle ─────────────────────────────────
        const finalState = await getProcessingState(daemon, sessionId);
        expect(finalState.status).toBe('idle');

        // ── Assertion 3: bounded error count — proves no infinite retry ───────────
        await new Promise((resolve) => setTimeout(resolve, 300));

        // With an infinite retry loop, error events would grow unbounded.
        // Retry-once caps at 2 timeout cycles. If the retry succeeds, 0 errors.
        // If the retry fails, a bounded number of error events.
        expect(errorEvents.length).toBeLessThanOrEqual(8);

        // All emitted errors (if any) must be startup-timeout errors.
        for (const ev of errorEvents) {
          expect(ev.message).toContain('failed to start');
        }
      } finally {
        unsubscribe();
      }
    },
    TEST_TIMEOUT
  );
});

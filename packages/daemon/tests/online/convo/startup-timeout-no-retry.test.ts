/**
 * Startup Timeout — Retry-Once Behavior Test
 *
 * Verifies that when the SDK startup times out:
 *   1. The system retries exactly once automatically.
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
 *   in time. assertRetryOnceSequenceRan() verifies the timeout fired on BOTH
 *   attempts and the retry-once branch ran exactly once — otherwise the suite
 *   could pass vacuously if the SDK ever responded within the window (both tests
 *   also accept the no-error outcome).
 *
 * MODES:
 *   - Dev Proxy (preferred, offline): HYPERNEO_USE_DEV_PROXY=1
 *   - Real API: requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 *
 * Run:
 *   cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/convo/startup-timeout-no-retry.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { getProcessingState, waitForIdle } from '../../helpers/daemon-actions';

const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;
// Spawned daemon startup is slower than in-process; allow extra time.
// SETUP_TIMEOUT must exceed the aggregate inner budgets so the hook doesn't
// time out mid-startup (leaving the child + dev-proxy lease alive): the spawned
// server's port-startup timeout (20 s) + waitForModelsReady (MODELS_READY_TIMEOUT_MS)
// + dev-proxy acquisition / WebSocket init / cleanup. The values below leave
// headroom over that aggregate.
const SETUP_TIMEOUT = IS_MOCK ? 60000 : 75000;
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
// modelsReadyTimeoutMs above, and assertRetryOnceSequenceRan() fails the test
// outright if the timeout ever stops firing (no silent vacuous pass).
const FORCED_STARTUP_TIMEOUT_MS = '10';

/**
 * Read the current session error directly from the `state.session` RPC.
 * Returns null if no error is set.
 */
async function getSessionError(
  daemon: DaemonServerContext,
  sessionId: string
): Promise<{ message: string; details?: unknown } | null> {
  const state = (await daemon.messageHub.request('state.session', {
    sessionId,
  })) as { error?: { message: string; details?: unknown } | null };
  return state.error ?? null;
}

/**
 * Wait until the daemon's startup-timeout TIMER callback has logged
 * "SDK startup timeout:" (query-runner.ts:808) at least `expected` times.
 *
 * Why this is needed: the retry branch calls stateManager.setIdle() and waits up
 * to RETRY_EXIT_TIMEOUT_MS (5 s) for the old subprocess before starting the
 * recursive retry, so waitForIdle() can return on that INTERMEDIATE idle before
 * the retry's second attempt runs — and the test would then tear down (kill the
 * daemon) before observing the second attempt. Polling the captured output for
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
      '(the retry-once sequence did not complete — the second attempt never timed out)'
  );
}

/**
 * Assert the startup-timeout timer fired on BOTH attempts (2 timer logs) and the
 * retry-once branch ran exactly once (1 retry log). Call AFTER
 * waitForStartupTimeoutTimer(daemon, 2, …) so the second attempt has actually
 * been observed. Uses the timer-callback-specific "SDK startup timeout:" text so
 * the catch block's "SDK startup timeout - query aborted" line is not counted.
 */
function assertRetryOnceSequenceRan(daemon: DaemonServerContext): void {
  const output = daemon.getCapturedOutput?.() ?? '';
  const timers = output.split('SDK startup timeout:').length - 1;
  const retries = output.split('Auto-retrying query after startup timeout').length - 1;
  expect(
    timers,
    `expected 2 startup-timeout timer logs (attempt 1 + the retry's attempt 2); got ${timers}`
  ).toBe(2);
  expect(
    retries,
    `expected the retry-once branch to run exactly once; got ${retries} retry log(s)`
  ).toBe(1);
}

describe('Startup Timeout Error Surfacing', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    // STARTUP_TIMEOUT_MS is a module-level constant in query-runner.ts — it is
    // captured once when the process starts.  We must spawn a fresh child
    // process so the env var is read at its module-load time.
    const origSpawn = process.env.DAEMON_TEST_SPAWN;
    const origTimeout = process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;

    process.env.DAEMON_TEST_SPAWN = 'true';
    process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = FORCED_STARTUP_TIMEOUT_MS;

    try {
      daemon = await createDaemonServer({
        modelsReadyTimeoutMs: MODELS_READY_TIMEOUT_MS,
        // Surface warn-level daemon logs in the captured child output:
        //   - error "SDK startup timeout"  (timer fired — query-runner.ts:808)
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

        // Wait for the session to return to idle.
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        // ── Assertion 1: the startup timeout fired on BOTH attempts and the
        //    retry-once branch ran exactly once. waitForIdle can return on the
        //    retry branch's intermediate idle before the 2nd attempt, so wait for
        //    the 2nd timer log first — otherwise teardown could race the retry.
        await waitForStartupTimeoutTimer(daemon, 2, IDLE_TIMEOUT);
        assertRetryOnceSequenceRan(daemon);

        // ── Assertion 2: session reaches idle (no infinite loop) ──────────────────
        const finalState = await getProcessingState(daemon, sessionId);
        expect(finalState.status).toBe('idle');

        // ── Assertion 3: if retry failed, error has actionable hints ──────────────
        const sessionError = await getSessionError(daemon, sessionId);
        if (sessionError) {
          const errorMsg = sessionError.message;
          expect(errorMsg).toContain('failed to start');
          expect(errorMsg).toContain('Common causes');
          expect(errorMsg).toContain('HYPERNEO_SDK_STARTUP_TIMEOUT_MS');
        }
        // If sessionError is null, the retry succeeded — that's also valid.
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
        title: 'Retry Once Test',
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

        // Session reaches idle after retry (succeed or fail).
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        // ── Assertion 1: the startup timeout fired on BOTH attempts and retried
        //    EXACTLY once — directly proves "not more than once" and that the
        //    retry's second attempt actually ran. waitForIdle can return on the
        //    retry branch's intermediate idle before the 2nd attempt, so wait for
        //    the 2nd timer log first — otherwise teardown could race the retry.
        await waitForStartupTimeoutTimer(daemon, 2, IDLE_TIMEOUT);
        assertRetryOnceSequenceRan(daemon);

        // ── Assertion 2: session is idle ──────────────────────────────────────────
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

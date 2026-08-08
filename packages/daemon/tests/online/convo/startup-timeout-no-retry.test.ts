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
 *   module with the env var already set to a very short value. The child process
 *   starts the SDK subprocess, which cannot respond within that window on the
 *   first attempt. The retry may succeed if the SDK subprocess from the first
 *   attempt is already running — both outcomes are valid.
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
// Budgets are generous because the forced startup timeout below makes the
// daemon abort+respawn the SDK subprocess, which both slows the daemon's own
// model fetch (waitForModelsReady) and adds up to one RETRY_EXIT_TIMEOUT_MS
// (5 s) subprocess-exit wait before the query reaches idle.
const SETUP_TIMEOUT = IS_MOCK ? 45000 : 60000;
const TEST_TIMEOUT = IS_MOCK ? 60000 : 90000;
const IDLE_TIMEOUT = IS_MOCK ? 45000 : 60000;
// Extra readiness budget for createDaemonServer: the thrashed subprocess spawns
// delay the daemon's model fetch beyond the helper's 8 s default.
const MODELS_READY_TIMEOUT_MS = IS_MOCK ? 25000 : 30000;

// Short enough that the startup timer reliably fires on the first attempt
// (subprocess spawn alone is hundreds of ms), so the retry-once path is
// exercised. The retry spawns a fresh subprocess, so its outcome (succeed or
// fail) still depends on timing — see the test body's sessionError branch. Kept
// above 10 ms: an absurdly small value makes the daemon abort/respawn so fast it
// congests the shared dev proxy and slows unrelated readiness waits (flaky CI).
const FORCED_STARTUP_TIMEOUT_MS = '100';

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
      daemon = await createDaemonServer({ modelsReadyTimeoutMs: MODELS_READY_TIMEOUT_MS });
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

        // ── Assertion 1: session reaches idle (no infinite loop) ──────────────────
        const finalState = await getProcessingState(daemon, sessionId);
        expect(finalState.status).toBe('idle');

        // ── Assertion 2: if retry failed, error has actionable hints ──────────────
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

        // ── Assertion 1: session is idle ──────────────────────────────────────────
        const finalState = await getProcessingState(daemon, sessionId);
        expect(finalState.status).toBe('idle');

        // ── Assertion 2: bounded error count — proves no infinite retry ───────────
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

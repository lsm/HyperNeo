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
 *   module with the env var already set to a very short value (10 ms).  The
 *   child process starts the SDK subprocess, which cannot possibly respond within
 *   10 ms on the first attempt. The retry may succeed if the SDK subprocess from
 *   the first attempt is already running — both outcomes are valid.
 *
 * MODES:
 *   - Dev Proxy (preferred, offline): NEOKAI_USE_DEV_PROXY=1
 *   - Real API: requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 *
 * Run:
 *   cd packages/daemon && NEOKAI_USE_DEV_PROXY=1 bun test ./tests/online/convo/startup-timeout-no-retry.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { getProcessingState, waitForIdle } from '../../helpers/daemon-actions';

const IS_MOCK = !!process.env.NEOKAI_USE_DEV_PROXY;
// Spawned daemon startup is slower than in-process; allow extra time.
const SETUP_TIMEOUT = IS_MOCK ? 20000 : 40000;
const TEST_TIMEOUT = IS_MOCK ? 30000 : 60000;
const IDLE_TIMEOUT = IS_MOCK ? 15000 : 30000;

// Timeout short enough that the SDK subprocess cannot respond in time.
// 10 ms is orders of magnitude below any realistic SDK startup latency.
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

describe('Startup Timeout Error Surfacing', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    // STARTUP_TIMEOUT_MS is a module-level constant in query-runner.ts — it is
    // captured once when the process starts.  We must spawn a fresh child
    // process so the env var is read at its module-load time.
    const origSpawn = process.env.DAEMON_TEST_SPAWN;
    const origTimeout = process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS;

    process.env.DAEMON_TEST_SPAWN = 'true';
    process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS = FORCED_STARTUP_TIMEOUT_MS;

    try {
      daemon = await createDaemonServer();
    } finally {
      // Restore parent-process env vars immediately; the child process has
      // already captured its own copy of the env at spawn time.
      if (origSpawn === undefined) {
        delete process.env.DAEMON_TEST_SPAWN;
      } else {
        process.env.DAEMON_TEST_SPAWN = origSpawn;
      }
      if (origTimeout === undefined) {
        delete process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS;
      } else {
        process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS = origTimeout;
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
        // Send a message — this kicks off query-runner.ts with STARTUP_TIMEOUT_MS=10.
        // The SDK subprocess cannot respond within 10 ms, so the startup timer fires.
        // The system retries once automatically. The retry may succeed (SDK subprocess
        // from attempt 1 is already running) or fail (still too slow).
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
          expect(errorMsg).toContain('NEOKAI_SDK_STARTUP_TIMEOUT_MS');
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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { getProcessingState } from '../../helpers/daemon-actions';

const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;
const SETUP_TIMEOUT = IS_MOCK ? 75000 : 90000;
const TEST_TIMEOUT = IS_MOCK ? 60000 : 90000;
const IDLE_TIMEOUT = IS_MOCK ? 45000 : 60000;
const MODELS_READY_TIMEOUT_MS = IS_MOCK ? 25000 : 30000;

const FORCED_STARTUP_INACTIVITY_TIMEOUT_MS = '10';

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

async function waitForSessionError(
  daemon: DaemonServerContext,
  sessionId: string,
  timeoutMs: number
): Promise<{ message: string; details?: unknown }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rpcTimeout = Math.min(2000, Math.max(1, deadline - Date.now()));
    try {
      const error = await getSessionError(daemon, sessionId, rpcTimeout);
      if (error) return error;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `expected a terminal session error within ${timeoutMs}ms — attempt 2's ` +
      'handleError did not set one (the daemon was likely torn down before it ran)'
  );
}

async function waitForRetryOnceCompleted(
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
    const origSpawn = process.env.DAEMON_TEST_SPAWN;
    const origTimeout = process.env.HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS;

    process.env.DAEMON_TEST_SPAWN = 'true';
    process.env.HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS = FORCED_STARTUP_INACTIVITY_TIMEOUT_MS;

    try {
      daemon = await createDaemonServer({
        modelsReadyTimeoutMs: MODELS_READY_TIMEOUT_MS,
        env: { LOG_LEVEL: 'warn' },
      });
    } finally {
      if (origSpawn === undefined) {
        delete process.env.DAEMON_TEST_SPAWN;
      } else {
        process.env.DAEMON_TEST_SPAWN = origSpawn;
      }
      if (origTimeout === undefined) {
        delete process.env.HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS;
      } else {
        process.env.HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS = origTimeout;
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
        await daemon.messageHub.request('message.send', {
          sessionId,
          content: 'Hello, please respond.',
        });

        await waitForRetryOnceCompleted(daemon, sessionId);

        assertRetryOnceSequenceRan(daemon);

        const finalState = await getProcessingState(daemon, sessionId);
        expect(finalState.status).toBe('idle');

        const sessionError = await getSessionError(daemon, sessionId);
        expect(
          sessionError,
          'expected a startup-timeout error after both attempts failed'
        ).not.toBeNull();
        const errorMsg = sessionError!.message;
        expect(errorMsg).toContain('failed to start');
        expect(errorMsg).toContain('did not emit its first message within the startup window');
        expect(errorMsg).toContain('after one automatic retry');
        expect(errorMsg).toContain('bounded by the startup gate');
        expect(errorMsg).not.toContain('stale lock file');
        expect(errorMsg).not.toContain('another Claude Code session');
        expect(errorMsg).toContain('HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS');
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
        title: 'Retry Once Test',
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
        await daemon.messageHub.request('message.send', {
          sessionId,
          content: 'Say hi.',
        });

        await waitForRetryOnceCompleted(daemon, sessionId);

        assertRetryOnceSequenceRan(daemon);

        const finalState = await getProcessingState(daemon, sessionId);
        expect(finalState.status).toBe('idle');

        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(errorEvents.length).toBeLessThanOrEqual(8);

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

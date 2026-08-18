import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';

const TMP_DIR = process.env.TMPDIR || '/tmp';

const COORDINATOR_AGENTS = [
  'Coordinator',
  'Coder',
  'Debugger',
  'Tester',
  'Reviewer',
  'VCS',
  'Verifier',
];

async function waitForSystemInit(
  daemon: DaemonServerContext,
  sessionId: string,
  timeout = 30000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        unsubscribe?.();
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for system:init message after ${timeout}ms`));
    }, timeout);

    unsubscribe = daemon.messageHub.onEvent('state.sdkMessages.delta', (data: unknown) => {
      if (resolved) return;

      const delta = data as { added?: Array<Record<string, unknown>> };
      const addedMessages = delta.added || [];

      for (const msg of addedMessages) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          cleanup();
          resolve(msg);
          return;
        }
      }
    });

    daemon.messageHub.joinChannel('session:' + sessionId).catch(() => {
      // Join failed, but continue - events might still work
    });
  });
}

function assertCoordinatorOn(systemInit: Record<string, unknown>) {
  const agents = systemInit.agents as string[] | undefined;
  expect(agents).toBeDefined();
  expect(agents!.length).toBeGreaterThanOrEqual(COORDINATOR_AGENTS.length);

  for (const expectedAgent of COORDINATOR_AGENTS) {
    expect(agents).toContain(expectedAgent);
  }
}

function assertCoordinatorOff(systemInit: Record<string, unknown>) {
  const agents = systemInit.agents as string[] | undefined;

  if (agents) {
    expect(agents).not.toContain('Coordinator');
    expect(agents).not.toContain('Coder');
    expect(agents).not.toContain('Debugger');
    expect(agents).not.toContain('Tester');
    expect(agents).not.toContain('Reviewer');
    expect(agents).not.toContain('VCS');
    expect(agents).not.toContain('Verifier');
  }
}

async function toggleCoordinatorMode(
  daemon: DaemonServerContext,
  sessionId: string,
  coordinatorMode: boolean
): Promise<void> {
  const result = (await daemon.messageHub.request('session.coordinator.switch', {
    sessionId,
    coordinatorMode,
  })) as { success: boolean; coordinatorMode: boolean; error?: string };

  expect(result.success).toBe(true);
  expect(result.coordinatorMode).toBe(coordinatorMode);
}

describe.skip('Coordinator Mode Switch - System Init Message', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer({
      env: {
        GLM_API_KEY: process.env.GLM_API_KEY!,
        DEFAULT_PROVIDER: 'glm',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        ANTHROPIC_API_KEY: '',
      },
    });
  }, 30000);

  afterEach(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, 20000);

  test('default ON → send → assert coordinator → OFF → send → assert no coordinator → ON → send → assert coordinator', async () => {
    const createResult = (await daemon.messageHub.request('session.create', {
      workspacePath: `${TMP_DIR}/test-coordinator-default-on-${Date.now()}`,
      title: 'Coordinator Default ON Test',
      config: {
        coordinatorMode: true,
        permissionMode: 'acceptEdits',
        model: 'glm-5',
      },
    })) as { sessionId: string };

    const { sessionId } = createResult;
    daemon.trackSession(sessionId);

    let systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'What is 1+1? Answer with just the number.');
    let systemInit = await systemInitPromise;

    assertCoordinatorOn(systemInit);
    await waitForIdle(daemon, sessionId, 90000);

    await toggleCoordinatorMode(daemon, sessionId, false);

    systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'What is 2+2? Answer with just the number.');
    systemInit = await systemInitPromise;

    assertCoordinatorOff(systemInit);
    await waitForIdle(daemon, sessionId, 90000);

    await toggleCoordinatorMode(daemon, sessionId, true);

    systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'What is 3+3? Answer with just the number.');
    systemInit = await systemInitPromise;

    assertCoordinatorOn(systemInit);
    await waitForIdle(daemon, sessionId, 90000);
  }, 300000);

  test('default OFF → send → assert no coordinator → ON → send → assert coordinator → OFF → send → assert no coordinator', async () => {
    const createResult = (await daemon.messageHub.request('session.create', {
      workspacePath: `${TMP_DIR}/test-coordinator-default-off-${Date.now()}`,
      title: 'Coordinator Default OFF Test',
      config: {
        coordinatorMode: false,
        permissionMode: 'acceptEdits',
        model: 'glm-5',
      },
    })) as { sessionId: string };

    const { sessionId } = createResult;
    daemon.trackSession(sessionId);

    let systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'What is 1+1? Answer with just the number.');
    let systemInit = await systemInitPromise;

    assertCoordinatorOff(systemInit);
    await waitForIdle(daemon, sessionId, 90000);

    await toggleCoordinatorMode(daemon, sessionId, true);

    systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'What is 2+2? Answer with just the number.');
    systemInit = await systemInitPromise;

    assertCoordinatorOn(systemInit);
    await waitForIdle(daemon, sessionId, 90000);

    await toggleCoordinatorMode(daemon, sessionId, false);

    systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'What is 3+3? Answer with just the number.');
    systemInit = await systemInitPromise;

    assertCoordinatorOff(systemInit);
    await waitForIdle(daemon, sessionId, 90000);
  }, 300000);

  test('system:init messages are immutable - each message preserves its coordinator state', async () => {
    const createResult = (await daemon.messageHub.request('session.create', {
      workspacePath: `${TMP_DIR}/test-coordinator-immutable-${Date.now()}`,
      title: 'Coordinator Immutability Test',
      config: {
        coordinatorMode: true,
        permissionMode: 'acceptEdits',
        model: 'glm-5',
      },
    })) as { sessionId: string };

    const { sessionId } = createResult;
    daemon.trackSession(sessionId);

    let systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'Message 1');
    const initWithCoordinator = await systemInitPromise;
    assertCoordinatorOn(initWithCoordinator);
    await waitForIdle(daemon, sessionId, 90000);

    await toggleCoordinatorMode(daemon, sessionId, false);
    systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'Message 2');
    const initWithoutCoordinator = await systemInitPromise;
    assertCoordinatorOff(initWithoutCoordinator);
    await waitForIdle(daemon, sessionId, 90000);

    const allMessages = (await daemon.messageHub.request('message.sdkMessages', {
      sessionId,
    })) as { sdkMessages: Array<Record<string, unknown>> };

    const systemInits = allMessages.sdkMessages.filter(
      (m) => m.type === 'system' && m.subtype === 'init'
    );

    expect(systemInits.length).toBeGreaterThanOrEqual(2);

    assertCoordinatorOn(systemInits[0]);

    assertCoordinatorOff(systemInits[systemInits.length - 1]);
  }, 180000);
});

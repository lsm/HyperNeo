/**
 * Coordinator Mode Switch - System Init Message Tests
 *
 * Tests that toggling coordinator mode mid-session correctly changes the
 * system:init message to reflect the coordinator agent and specialist agents.
 *
 * Each system:init message is per-message and immutable once saved.
 * When coordinator mode is ON:
 *   - system:init.agents should include coordinator + 6 specialists
 *   - The agent field should be 'coordinator'
 * When coordinator mode is OFF:
 *   - system:init.agents should be the default SDK agents (Bash, Explore, etc.)
 *   - No 'coordinator' agent field
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls
 *
 * TEST SCENARIOS:
 * 1. Default coordinator ON → send message → assert coordinator agents →
 *    toggle OFF → send message → assert no coordinator agents →
 *    toggle ON → send message → assert coordinator agents again
 *
 * 2. Default coordinator OFF → send message → assert no coordinator agents →
 *    toggle ON → send message → assert coordinator agents →
 *    toggle OFF → send message → assert no coordinator agents again
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
// Bun automatically loads .env from project root when running tests
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';

const TMP_DIR = process.env.TMPDIR || '/tmp';

/** Expected coordinator specialist agent names */
const COORDINATOR_AGENTS = [
  'Coordinator',
  'Coder',
  'Debugger',
  'Tester',
  'Reviewer',
  'VCS',
  'Verifier',
];

/**
 * Wait for a system:init SDK message via subscription.
 *
 * Subscribes to events BEFORE joining the room, then joins and stays in the room
 * (no leaveRoom in cleanup) to avoid room state races between multi-phase tests.
 */
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

    // Subscribe FIRST so no events are missed once room join completes
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

    // Join the session room (idempotent - safe to call multiple times)
    daemon.messageHub.joinChannel('session:' + sessionId).catch(() => {
      // Join failed, but continue - events might still work
    });
  });
}

/**
 * Assert that a system:init message reflects coordinator mode being ON
 */
function assertCoordinatorOn(systemInit: Record<string, unknown>) {
  const agents = systemInit.agents as string[] | undefined;
  expect(agents).toBeDefined();
  expect(agents!.length).toBeGreaterThanOrEqual(COORDINATOR_AGENTS.length);

  // All coordinator specialist agents should be present
  for (const expectedAgent of COORDINATOR_AGENTS) {
    expect(agents).toContain(expectedAgent);
  }
}

/**
 * Assert that a system:init message reflects coordinator mode being OFF
 */
function assertCoordinatorOff(systemInit: Record<string, unknown>) {
  const agents = systemInit.agents as string[] | undefined;

  // When coordinator is off, there should be no 'Coordinator' agent
  // agents may be undefined or an array without coordinator-specific agents
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

/**
 * Toggle coordinator mode on a session via session.coordinator.switch
 * This single RPC updates config and auto-restarts the query
 */
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

// TODO: Re-enable when CI concurrency issues are resolved
// These tests keep getting cancelled due to concurrent runs and use GLM API
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
    // 1. Create session with coordinator mode ON
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

    // --- Phase 1: Coordinator ON - send message ---
    let systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'What is 1+1? Answer with just the number.');
    let systemInit = await systemInitPromise;

    assertCoordinatorOn(systemInit);
    await waitForIdle(daemon, sessionId, 90000);

    // --- Phase 2: Toggle OFF - send message ---
    await toggleCoordinatorMode(daemon, sessionId, false);

    systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'What is 2+2? Answer with just the number.');
    systemInit = await systemInitPromise;

    assertCoordinatorOff(systemInit);
    await waitForIdle(daemon, sessionId, 90000);

    // --- Phase 3: Toggle back ON - send message ---
    await toggleCoordinatorMode(daemon, sessionId, true);

    systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'What is 3+3? Answer with just the number.');
    systemInit = await systemInitPromise;

    assertCoordinatorOn(systemInit);
    await waitForIdle(daemon, sessionId, 90000);
  }, 300000);

  test('default OFF → send → assert no coordinator → ON → send → assert coordinator → OFF → send → assert no coordinator', async () => {
    // 1. Create session with coordinator mode OFF
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

    // --- Phase 1: Coordinator OFF - send message ---
    let systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'What is 1+1? Answer with just the number.');
    let systemInit = await systemInitPromise;

    assertCoordinatorOff(systemInit);
    await waitForIdle(daemon, sessionId, 90000);

    // --- Phase 2: Toggle ON - send message ---
    await toggleCoordinatorMode(daemon, sessionId, true);

    systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'What is 2+2? Answer with just the number.');
    systemInit = await systemInitPromise;

    assertCoordinatorOn(systemInit);
    await waitForIdle(daemon, sessionId, 90000);

    // --- Phase 3: Toggle back OFF - send message ---
    await toggleCoordinatorMode(daemon, sessionId, false);

    systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'What is 3+3? Answer with just the number.');
    systemInit = await systemInitPromise;

    assertCoordinatorOff(systemInit);
    await waitForIdle(daemon, sessionId, 90000);
  }, 300000);

  test('system:init messages are immutable - each message preserves its coordinator state', async () => {
    // This test verifies that each system:init message is tied to its query,
    // and toggling coordinator mode doesn't retroactively change earlier messages.

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

    // Phase 1: Send with coordinator ON
    let systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'Message 1');
    const initWithCoordinator = await systemInitPromise;
    assertCoordinatorOn(initWithCoordinator);
    await waitForIdle(daemon, sessionId, 90000);

    // Phase 2: Toggle OFF and send
    await toggleCoordinatorMode(daemon, sessionId, false);
    systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'Message 2');
    const initWithoutCoordinator = await systemInitPromise;
    assertCoordinatorOff(initWithoutCoordinator);
    await waitForIdle(daemon, sessionId, 90000);

    // Verify: Fetch all SDK messages and check each system:init is preserved
    const allMessages = (await daemon.messageHub.request('message.sdkMessages', {
      sessionId,
    })) as { sdkMessages: Array<Record<string, unknown>> };

    const systemInits = allMessages.sdkMessages.filter(
      (m) => m.type === 'system' && m.subtype === 'init'
    );

    // Should have at least 2 system:init messages (one per query start)
    expect(systemInits.length).toBeGreaterThanOrEqual(2);

    // First init should have coordinator agents
    assertCoordinatorOn(systemInits[0]);

    // Last init should NOT have coordinator agents
    assertCoordinatorOff(systemInits[systemInits.length - 1]);
  }, 180000);
});

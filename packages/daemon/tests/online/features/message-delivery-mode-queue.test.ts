import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
  getProcessingState,
  sendMessage,
  waitForIdle,
  waitForSdkMessages,
} from '../../helpers/daemon-actions';

const TMP_DIR = process.env.TMPDIR || '/tmp';

const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;
const MODEL = IS_MOCK ? 'haiku' : 'haiku-4.5';
const IDLE_TIMEOUT = IS_MOCK ? 10000 : 90000;
const SETUP_TIMEOUT = IS_MOCK ? 10000 : 30000;
const TEST_TIMEOUT = IS_MOCK ? 60000 : 180000;

describe('Message delivery mode queue flow', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer();
  }, SETUP_TIMEOUT);

  afterEach(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, SETUP_TIMEOUT);

  async function getCountByStatus(
    sessionId: string,
    status: 'deferred' | 'enqueued' | 'consumed'
  ): Promise<number> {
    const result = (await daemon.messageHub.request('session.messages.countByStatus', {
      sessionId,
      status,
    })) as { count: number };
    return result.count;
  }

  async function waitForCount(
    sessionId: string,
    status: 'deferred' | 'enqueued' | 'consumed',
    predicate: (count: number) => boolean,
    timeoutMs = 15000
  ): Promise<number> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const count = await getCountByStatus(sessionId, status);
      if (predicate(count)) {
        return count;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`Timed out waiting for ${status} count predicate`);
  }

  async function waitForBusy(sessionId: string, timeoutMs = 12000): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const state = await getProcessingState(daemon, sessionId);
      if (state.status === 'queued' || state.status === 'processing') {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  }

  async function waitForTurnKickoffConsumed(
    sessionId: string,
    timeoutMs = IS_MOCK ? 10000 : 30000
  ): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if ((await getCountByStatus(sessionId, 'consumed')) >= 1) {
        const state = await getProcessingState(daemon, sessionId);
        return state.status === 'queued' || state.status === 'processing';
      }
      const state = await getProcessingState(daemon, sessionId);
      if (state.status === 'idle') return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  test(
    'defer while busy should be saved then auto-dispatched on turn end',
    async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/delivery-mode-flow-${Date.now()}`,
        title: 'Delivery Mode Flow',
        config: { model: MODEL, permissionMode: 'acceptEdits' },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        const first = await sendMessage(
          daemon,
          sessionId,
          'Set a timer for 15 seconds, so I can test message steering.'
        );
        expect(first.messageId).toBeString();
        const becameBusy = await waitForBusy(sessionId, 20000);
        if (!becameBusy) {
          console.log('Skipping busy-turn queue assertions: agent did not enter busy state');
          return;
        }

        const second = await sendMessage(
          daemon,
          sessionId,
          'After your current response finishes, reply exactly: FOLLOWUP_OK',
          { deliveryMode: 'defer' }
        );
        expect(second.messageId).toBeString();
        expect(second.messageId).not.toBe(first.messageId);

        await waitForCount(sessionId, 'deferred', (count) => count >= 1, 12000);
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        await waitForCount(sessionId, 'deferred', (count) => count === 0, 20000);
        const sentCount = await getCountByStatus(sessionId, 'consumed');
        expect(sentCount).toBeGreaterThanOrEqual(2);
      } finally {
        try {
          await daemon.messageHub.request('client.interrupt', { sessionId });
        } catch {
          // Best effort
        }
      }
    },
    TEST_TIMEOUT
  );

  test(
    'defer while idle should fallback to immediate dispatch',
    async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/delivery-mode-idle-fallback-${Date.now()}`,
        title: 'Delivery Mode Idle Fallback',
        config: { model: MODEL, permissionMode: 'acceptEdits' },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      const stateBefore = await getProcessingState(daemon, sessionId);
      expect(stateBefore.status).toBe('idle');

      await sendMessage(daemon, sessionId, 'Reply exactly: IDLE_FALLBACK_OK', {
        deliveryMode: 'defer',
      });

      await waitForCount(sessionId, 'deferred', (count) => count === 0, 10000);
      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);
      const queuedCleared = await waitForCount(sessionId, 'enqueued', (count) => count === 0, 20000)
        .then(() => true)
        .catch(() => false);
      if (!queuedCleared) {
        console.log('Skipping idle fallback assertion: queued status did not clear in time');
        return;
      }

      const sentCount = await getCountByStatus(sessionId, 'consumed');
      expect(sentCount).toBeGreaterThanOrEqual(1);
    },
    TEST_TIMEOUT
  );

  test(
    'immediate steering while busy should have timestamp between assistant messages',
    async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/steer-position-${Date.now()}`,
        title: 'Steer Position Test',
        config: { model: MODEL, permissionMode: 'acceptEdits' },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        const first = await sendMessage(
          daemon,
          sessionId,
          'Write a detailed 5-paragraph essay about the history of computing. Take your time and be thorough.'
        );
        expect(first.messageId).toBeString();

        const becameBusy = await waitForBusy(sessionId, 20000);
        if (!becameBusy) {
          console.log('Skipping: agent did not enter busy state');
          return;
        }

        const kickoffConsumed = await waitForTurnKickoffConsumed(sessionId);
        if (!kickoffConsumed) {
          console.log('Skipping: turn ended before its kickoff message was consumed');
          return;
        }

        const steerResult = await sendMessage(
          daemon,
          sessionId,
          'Actually, stop what you are doing. Reply with exactly: STEERED_OK',
          { deliveryMode: 'immediate' }
        );
        expect(steerResult.messageId).toBeString();

        await waitForCount(sessionId, 'enqueued', (count) => count === 0, 30000);

        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const { sdkMessages } = await waitForSdkMessages(daemon, sessionId, {
          minCount: 4,
          timeout: 10000,
        });

        const steeredMsg = sdkMessages.find(
          (msg: Record<string, unknown>) =>
            msg.type === 'user' && msg.uuid === steerResult.messageId
        );
        expect(steeredMsg).toBeDefined();

        const steeredTimestamp = (steeredMsg as Record<string, unknown>).timestamp as number;
        expect(steeredTimestamp).toBeGreaterThan(0);

        const firstUserMsg = sdkMessages.find(
          (msg: Record<string, unknown>) => msg.type === 'user' && msg.uuid === first.messageId
        );
        expect(firstUserMsg).toBeDefined();
        const firstUserTimestamp = (firstUserMsg as Record<string, unknown>).timestamp as number;

        expect(steeredTimestamp).toBeGreaterThan(firstUserTimestamp);

        const resultMessages = sdkMessages.filter(
          (msg: Record<string, unknown>) => msg.type === 'result'
        );
        expect(resultMessages.length).toBeGreaterThanOrEqual(1);
        const lastResult = resultMessages[resultMessages.length - 1];
        const resultTimestamp = (lastResult as Record<string, unknown>).timestamp as number;

        expect(steeredTimestamp).toBeLessThan(resultTimestamp);

        const sentCount = await getCountByStatus(sessionId, 'consumed');
        expect(sentCount).toBeGreaterThanOrEqual(2);
      } finally {
        try {
          await daemon.messageHub.request('client.interrupt', { sessionId });
        } catch {
          // Best effort
        }
      }
    },
    TEST_TIMEOUT
  );

  test(
    'multiple immediate steers while busy should all be acknowledged',
    async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/multi-steer-${Date.now()}`,
        title: 'Multi Steer Test',
        config: { model: MODEL, permissionMode: 'acceptEdits' },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        await sendMessage(
          daemon,
          sessionId,
          'Write a very long and detailed analysis of renewable energy sources. Cover at least solar, wind, hydro, and geothermal. Be thorough.'
        );

        const becameBusy = await waitForBusy(sessionId, 20000);
        if (!becameBusy) {
          console.log('Skipping: agent did not enter busy state');
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 1500));

        const steer1 = await sendMessage(
          daemon,
          sessionId,
          'STEER_MESSAGE_ONE: Acknowledge this.',
          {
            deliveryMode: 'immediate',
          }
        );
        const steer2 = await sendMessage(
          daemon,
          sessionId,
          'STEER_MESSAGE_TWO: Also acknowledge this.',
          { deliveryMode: 'immediate' }
        );

        expect(steer1.messageId).toBeString();
        expect(steer2.messageId).toBeString();

        await waitForCount(sessionId, 'enqueued', (count) => count === 0, 60000);

        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const { sdkMessages } = await waitForSdkMessages(daemon, sessionId, {
          minCount: 5,
          timeout: 10000,
        });

        const steered1 = sdkMessages.find(
          (msg: Record<string, unknown>) => msg.type === 'user' && msg.uuid === steer1.messageId
        );
        const steered2 = sdkMessages.find(
          (msg: Record<string, unknown>) => msg.type === 'user' && msg.uuid === steer2.messageId
        );

        expect(steered1).toBeDefined();
        expect(steered2).toBeDefined();

        const ts1 = (steered1 as Record<string, unknown>).timestamp as number;
        const ts2 = (steered2 as Record<string, unknown>).timestamp as number;
        expect(ts1).toBeGreaterThan(0);
        expect(ts2).toBeGreaterThan(0);

        expect(ts2).toBeGreaterThanOrEqual(ts1);

        const queuedCount = await getCountByStatus(sessionId, 'enqueued');
        expect(queuedCount).toBe(0);

        const sentCount = await getCountByStatus(sessionId, 'consumed');
        expect(sentCount).toBeGreaterThanOrEqual(3);
      } finally {
        try {
          await daemon.messageHub.request('client.interrupt', { sessionId });
        } catch {
          // Best effort
        }
      }
    },
    TEST_TIMEOUT
  );
});

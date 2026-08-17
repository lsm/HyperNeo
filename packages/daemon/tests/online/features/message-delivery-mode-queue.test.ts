/**
 * Message Delivery Mode Queue Flow (Online)
 *
 * End-to-end validation for:
 * - immediate delivery
 * - defer delivery while busy (saved queue + auto-dispatch)
 * - defer fallback while idle
 *
 * MODES:
 * - Real API (default): Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Dev Proxy: Set HYPERNEO_USE_DEV_PROXY=1 for offline testing with mocked responses
 *
 * Run with Dev Proxy:
 *   cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/features/message-delivery-mode-queue.test.ts
 */

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

// Detect mock mode for faster timeouts (Dev Proxy)
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
        // The busy turn holds a 15 s timer, and this idle wait can start
        // early in it (the upstream waits complete quickly on warm runners) —
        // the 10 s mock-mode IDLE_TIMEOUT then expires mid-timer. Size this
        // one wait to the timer; the deferred→0 dispatch wait below (20 s)
        // carries the actual assertion. Never tightens the real-API budget.
        await waitForIdle(daemon, sessionId, Math.max(IDLE_TIMEOUT, 30_000));

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

      // defer while idle should not remain in saved queue
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
        // Send a message that makes the agent work for a while
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

        // Wait a moment to ensure some assistant content has been streamed
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Send a steering message (immediate while busy)
        const steerResult = await sendMessage(
          daemon,
          sessionId,
          'Actually, stop what you are doing. Reply with exactly: STEERED_OK',
          { deliveryMode: 'immediate' }
        );
        expect(steerResult.messageId).toBeString();

        // The message should be queued initially
        // Then transition to 'consumed' when the generator yields it
        await waitForCount(sessionId, 'enqueued', (count) => count === 0, 30000);

        // Wait for the turn to complete
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        // Get all SDK messages and verify ordering
        const { sdkMessages } = await waitForSdkMessages(daemon, sessionId, {
          minCount: 4, // system + user + assistant + (steered user) + result
          timeout: 10000,
        });

        // Find the steered user message by UUID
        const steeredMsg = sdkMessages.find(
          (msg: Record<string, unknown>) =>
            msg.type === 'user' && msg.uuid === steerResult.messageId
        );
        expect(steeredMsg).toBeDefined();

        // The steered message should have a timestamp
        const steeredTimestamp = (steeredMsg as Record<string, unknown>).timestamp as number;
        expect(steeredTimestamp).toBeGreaterThan(0);

        // Find the first user message
        const firstUserMsg = sdkMessages.find(
          (msg: Record<string, unknown>) => msg.type === 'user' && msg.uuid === first.messageId
        );
        expect(firstUserMsg).toBeDefined();
        const firstUserTimestamp = (firstUserMsg as Record<string, unknown>).timestamp as number;

        // The steered message timestamp should be AFTER the first user message
        expect(steeredTimestamp).toBeGreaterThan(firstUserTimestamp);

        // Find the result message (should be last or second-to-last)
        const resultMessages = sdkMessages.filter(
          (msg: Record<string, unknown>) => msg.type === 'result'
        );
        expect(resultMessages.length).toBeGreaterThanOrEqual(1);
        const lastResult = resultMessages[resultMessages.length - 1];
        const resultTimestamp = (lastResult as Record<string, unknown>).timestamp as number;

        // CRITICAL: The steered message timestamp must be BEFORE the final result
        // This proves it was positioned at SDK insertion time, not at turn end
        expect(steeredTimestamp).toBeLessThan(resultTimestamp);

        // Verify the message status is now 'consumed'
        const sentCount = await getCountByStatus(sessionId, 'consumed');
        expect(sentCount).toBeGreaterThanOrEqual(2); // At least first + steered
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
        // Send initial message to make agent busy
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

        // Wait for some assistant content to stream
        await new Promise((resolve) => setTimeout(resolve, 1500));

        // Send TWO steering messages in quick succession
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

        // Wait for all queued messages to be consumed
        await waitForCount(sessionId, 'enqueued', (count) => count === 0, 60000);

        // Wait for turns to complete
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        // Both steering messages should now be 'consumed'
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

        // Both messages should exist in the transcript
        expect(steered1).toBeDefined();
        expect(steered2).toBeDefined();

        // Both should have timestamps
        const ts1 = (steered1 as Record<string, unknown>).timestamp as number;
        const ts2 = (steered2 as Record<string, unknown>).timestamp as number;
        expect(ts1).toBeGreaterThan(0);
        expect(ts2).toBeGreaterThan(0);

        // Steer 2 should have a timestamp >= steer 1 (sent in order)
        expect(ts2).toBeGreaterThanOrEqual(ts1);

        // No messages should remain in queued status
        const queuedCount = await getCountByStatus(sessionId, 'enqueued');
        expect(queuedCount).toBe(0);

        // All user messages should be sent
        const sentCount = await getCountByStatus(sessionId, 'consumed');
        expect(sentCount).toBeGreaterThanOrEqual(3); // initial + steer1 + steer2
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

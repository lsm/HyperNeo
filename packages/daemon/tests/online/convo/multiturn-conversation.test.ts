import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { getProcessingState, sendMessage, waitForIdle } from '../../helpers/daemon-actions';

const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;
const MODEL = IS_MOCK ? 'haiku' : 'haiku-4.5';
const IDLE_TIMEOUT = IS_MOCK ? 15000 : 30000;
const SETUP_TIMEOUT = IS_MOCK ? 10000 : 30000;
const TEST_TIMEOUT = IS_MOCK ? 30000 : 150000;

describe('Multi-Turn Conversation', () => {
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

  test(
    'should handle multi-turn conversation with context retention',
    async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: process.cwd(),
        title: 'Context Retention Test',
        config: {
          model: MODEL,
          permissionMode: 'acceptEdits',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      const result1 = await sendMessage(
        daemon,
        sessionId,
        'What is 5 + 7? Just reply with the number.'
      );
      expect(result1.messageId).toBeString();

      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

      const result2 = await sendMessage(
        daemon,
        sessionId,
        'Now add 3 to that result. Just reply with the number.'
      );
      expect(result2.messageId).toBeString();
      expect(result2.messageId).not.toBe(result1.messageId);

      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

      const finalState = await getProcessingState(daemon, sessionId);
      expect(finalState.status).toBe('idle');
    },
    TEST_TIMEOUT
  );

  test(
    'should handle multi-turn conversation with code analysis',
    async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: process.cwd(),
        title: 'Code Analysis Test',
        config: {
          model: MODEL,
          permissionMode: 'acceptEdits',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      await sendMessage(
        daemon,
        sessionId,
        'I will show you a TypeScript function. Just reply "Ready, show me the code."'
      );
      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

      await sendMessage(
        daemon,
        sessionId,
        'Here is the code:\n\n```typescript\nfunction add(a: number, b: number): number {\n  return a + b;\n}\n```\n\nWhat does this function do? Answer in one sentence.'
      );
      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

      await sendMessage(
        daemon,
        sessionId,
        'What are the parameter types? Just list them separated by commas.'
      );
      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

      const finalState = await getProcessingState(daemon, sessionId);
      expect(finalState.status).toBe('idle');
    },
    TEST_TIMEOUT
  );

  test(
    'should handle rapid successive messages correctly',
    async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: process.cwd(),
        title: 'Rapid Messages Test',
        config: {
          model: MODEL,
          permissionMode: 'acceptEdits',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      const msg1 = await sendMessage(daemon, sessionId, 'First message: Say "One".');
      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

      const msg2 = await sendMessage(daemon, sessionId, 'Second message: Say "Two".');
      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

      const msg3 = await sendMessage(daemon, sessionId, 'Third message: Say "Three".');
      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

      expect(msg1.messageId).not.toBe(msg2.messageId);
      expect(msg2.messageId).not.toBe(msg3.messageId);
      expect(msg1.messageId).not.toBe(msg3.messageId);

      const finalState = await getProcessingState(daemon, sessionId);
      expect(finalState.status).toBe('idle');
    },
    TEST_TIMEOUT
  );

  describe('Processing state transitions across turns', () => {
    test(
      'should correctly transition through states for each turn',
      async () => {
        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath: process.cwd(),
          title: 'State Transitions Test',
          config: {
            model: MODEL,
            permissionMode: 'acceptEdits',
          },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        for (let i = 1; i <= 3; i++) {
          const initialState = await getProcessingState(daemon, sessionId);
          expect(initialState.status).toBe('idle');

          await sendMessage(daemon, sessionId, `Turn ${i}: Say "Done". Just that word.`);

          const processingState = await getProcessingState(daemon, sessionId);
          expect(['queued', 'processing', 'idle']).toContain(processingState.status);

          await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

          const finalState = await getProcessingState(daemon, sessionId);
          expect(finalState.status).toBe('idle');
        }
      },
      TEST_TIMEOUT
    );
  });
});

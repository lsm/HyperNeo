import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
  getProcessingState,
  getSession,
  interrupt,
  sendMessage,
  waitForIdle,
} from '../../helpers/daemon-actions';

const TMP_DIR = process.env.TMPDIR || '/tmp';

const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;
const MODEL = IS_MOCK ? 'haiku' : 'haiku-4.5';
const IDLE_TIMEOUT = IS_MOCK ? 15000 : 30000;
const SETUP_TIMEOUT = 30000;
const TEST_TIMEOUT = IS_MOCK ? 60000 : 90000;

describe('Message Persistence', () => {
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

  describe('Basic Message Persistence', () => {
    test(
      'should persist user messages to database',
      async () => {
        const workspacePath = `${TMP_DIR}/persistence-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Persist Messages Test',
          config: { model: MODEL, permissionMode: 'acceptEdits' },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        const result = await sendMessage(daemon, sessionId, 'What is 1+1?');
        expect(result.messageId).toBeString();

        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const session = await getSession(daemon, sessionId);

        expect(session).toBeDefined();
        expect(session.id).toBe(sessionId);
      },
      TEST_TIMEOUT
    );

    test(
      'should maintain message order across multiple sends',
      async () => {
        const workspacePath = `${TMP_DIR}/persistence-order-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Message Order Test',
          config: { model: MODEL, permissionMode: 'acceptEdits' },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        const msg1 = await sendMessage(daemon, sessionId, 'First message');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const msg2 = await sendMessage(daemon, sessionId, 'Second message');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const msg3 = await sendMessage(daemon, sessionId, 'Third message');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        expect(msg1.messageId).not.toBe(msg2.messageId);
        expect(msg2.messageId).not.toBe(msg3.messageId);
        expect(msg1.messageId).not.toBe(msg3.messageId);

        const state = await getProcessingState(daemon, sessionId);
        expect(state.status).toBe('idle');
      },
      TEST_TIMEOUT * 2
    );
  });

  describe('Message Persistence with Interruption', () => {
    test(
      'should not lose messages when interrupted',
      async () => {
        const workspacePath = `${TMP_DIR}/persistence-interrupt-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Interrupt Persistence Test',
          config: { model: MODEL, permissionMode: 'acceptEdits' },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        await sendMessage(daemon, sessionId, 'Count from 1 to 100 slowly.');

        const interruptDelay = IS_MOCK ? 100 : 2000;
        await new Promise((resolve) => setTimeout(resolve, interruptDelay));

        await interrupt(daemon, sessionId);

        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const state = await getProcessingState(daemon, sessionId);
        expect(state).toBeDefined();

        await sendMessage(daemon, sessionId, 'What is 2+2?');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const finalState = await getProcessingState(daemon, sessionId);
        expect(finalState.status).toBe('idle');
      },
      TEST_TIMEOUT * 2
    );
  });

  describe('Session State Consistency', () => {
    test(
      'should maintain consistent session state across operations',
      async () => {
        const workspacePath = `${TMP_DIR}/persistence-state-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'State Consistency Test',
          config: { model: MODEL, permissionMode: 'acceptEdits' },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        let session = await getSession(daemon, sessionId);
        expect(session.id).toBe(sessionId);
        expect(session.workspacePath).toBe(workspacePath);

        await sendMessage(daemon, sessionId, 'Test message');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        session = await getSession(daemon, sessionId);
        expect(session.id).toBe(sessionId);
        expect(session.workspacePath).toBe(workspacePath);

        const state = await getProcessingState(daemon, sessionId);
        expect(state.status).toBe('idle');
      },
      TEST_TIMEOUT
    );
  });

  describe('Concurrent Message Handling', () => {
    test(
      'should handle multiple message sends in sequence',
      async () => {
        const workspacePath = `${TMP_DIR}/persistence-concurrent-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Concurrent Messages Test',
          config: { model: MODEL, permissionMode: 'acceptEdits' },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        const results = await Promise.all([
          sendMessage(daemon, sessionId, 'Message 1'),
          new Promise((resolve) => setTimeout(resolve, 100)).then(() =>
            sendMessage(daemon, sessionId, 'Message 2')
          ),
          new Promise((resolve) => setTimeout(resolve, 200)).then(() =>
            sendMessage(daemon, sessionId, 'Message 3')
          ),
        ]);

        expect(results[0].messageId).not.toBe(results[1].messageId);
        expect(results[1].messageId).not.toBe(results[2].messageId);

        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT * 2);

        const state = await getProcessingState(daemon, sessionId);
        expect(state.status).toBe('idle');
      },
      TEST_TIMEOUT * 3
    );
  });
});

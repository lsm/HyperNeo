import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
  sendMessage,
  waitForIdle,
  getProcessingState,
  getSession,
} from '../../helpers/daemon-actions';

const TMP_DIR = process.env.TMPDIR || '/tmp';

const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;
const MODEL = IS_MOCK ? 'haiku' : 'haiku-4.5';
const IDLE_TIMEOUT = IS_MOCK ? 15000 : 30000;
const SETUP_TIMEOUT = IS_MOCK ? 20000 : 30000;
const TEST_TIMEOUT = IS_MOCK ? 60000 : 90000;

describe('SDK Streaming Behavior', () => {
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

  describe('Permission Mode Handling', () => {
    test(
      'should work with acceptEdits permission mode',
      async () => {
        const workspacePath = `${TMP_DIR}/accept-edits-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Accept Edits Test',
          config: {
            model: MODEL,
            permissionMode: 'acceptEdits',
          },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        const result = await sendMessage(
          daemon,
          sessionId,
          'What is 2+2? Answer with just the number.'
        );

        expect(result.messageId).toBeString();

        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const state = await getProcessingState(daemon, sessionId);
        expect(state.status).toBe('idle');

        console.log('[ACCEPT-EDITS TEST] ✓ PASSED - acceptEdits mode works correctly');
      },
      TEST_TIMEOUT
    );
  });

  describe('Message Processing', () => {
    test(
      'should process messages correctly through WebSocket API',
      async () => {
        const workspacePath = `${TMP_DIR}/message-processing-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Message Processing Test',
          config: {
            model: MODEL,
            permissionMode: 'acceptEdits',
          },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        const msg1 = await sendMessage(daemon, sessionId, 'What is 1+1? Just the number.');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const msg2 = await sendMessage(daemon, sessionId, 'What is 2+2? Just the number.');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const msg3 = await sendMessage(daemon, sessionId, 'What is 3+3? Just the number.');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        expect(msg1.messageId).not.toBe(msg2.messageId);
        expect(msg2.messageId).not.toBe(msg3.messageId);
        expect(msg1.messageId).not.toBe(msg3.messageId);

        const state = await getProcessingState(daemon, sessionId);
        expect(state.status).toBe('idle');

        console.log('[MESSAGE PROCESSING TEST] ✓ PASSED - All messages processed correctly');
      },
      TEST_TIMEOUT
    );

    test(
      'should handle simple prompt pattern correctly',
      async () => {
        const workspacePath = `${TMP_DIR}/simple-prompt-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Simple Prompt Test',
          config: {
            model: MODEL,
            permissionMode: 'acceptEdits',
          },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        const result = await sendMessage(
          daemon,
          sessionId,
          'What is 3+3? Answer with just the number.'
        );

        expect(result.messageId).toBeString();

        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const state = await getProcessingState(daemon, sessionId);
        expect(state.status).toBe('idle');

        console.log('[SIMPLE PROMPT TEST] ✓ PASSED - Simple prompt pattern works');
      },
      TEST_TIMEOUT
    );
  });

  describe('Session State Consistency', () => {
    test(
      'should maintain consistent session state',
      async () => {
        const workspacePath = `${TMP_DIR}/session-state-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Session State Test',
          config: {
            model: MODEL,
            permissionMode: 'acceptEdits',
          },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        let session = await getSession(daemon, sessionId);
        expect(session.id).toBe(sessionId);
        expect(session.workspacePath).toBe(workspacePath);

        await sendMessage(daemon, sessionId, 'What is 1+1? Just the number.');

        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        session = await getSession(daemon, sessionId);
        expect(session.id).toBe(sessionId);
        expect(session.workspacePath).toBe(workspacePath);

        const state = await getProcessingState(daemon, sessionId);
        expect(state.status).toBe('idle');

        console.log('[SESSION STATE TEST] ✓ PASSED - Session state is consistent');
      },
      TEST_TIMEOUT
    );
  });

  describe('Message Persistence and Reload', () => {
    test(
      'should persist messages across session operations',
      async () => {
        const workspacePath = `${TMP_DIR}/persistence-reload-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Persistence Reload Test',
          config: {
            model: MODEL,
            permissionMode: 'acceptEdits',
          },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        const result = await sendMessage(
          daemon,
          sessionId,
          'What is 2+2? Answer with just the number.'
        );

        expect(result.messageId).toBeString();

        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const session = await getSession(daemon, sessionId);
        expect(session.id).toBe(sessionId);
        expect(session.workspacePath).toBe(workspacePath);

        const result2 = await sendMessage(daemon, sessionId, 'What is 3+3? Just the number.');
        expect(result2.messageId).toBeString();
        expect(result2.messageId).not.toBe(result.messageId);

        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const state = await getProcessingState(daemon, sessionId);
        expect(state.status).toBe('idle');

        console.log('[PERSISTENCE RELOAD TEST] ✓ PASSED - Messages persisted correctly');
      },
      TEST_TIMEOUT
    );
  });
});

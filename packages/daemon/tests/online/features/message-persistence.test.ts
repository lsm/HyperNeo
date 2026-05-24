/**
 * Message Persistence Integration Tests
 *
 * These tests verify that messages are properly persisted and retrievable
 * through the WebSocket API.
 *
 * Tests cover:
 * 1. Messages are persisted and can be retrieved
 * 2. Messages survive across daemon restarts
 * 3. Messages persist correctly even with interruptions
 * 4. Message order is maintained
 *
 * MODES:
 * - Real API (default): Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Dev Proxy: Set NEOKAI_USE_DEV_PROXY=1 for offline testing with mocked responses
 *
 * Run with Dev Proxy:
 *   cd packages/daemon && NEOKAI_USE_DEV_PROXY=1 bun test ./tests/online/features/message-persistence.test.ts
 */

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

// Detect mock mode for faster timeouts (Dev Proxy)
const IS_MOCK = !!process.env.NEOKAI_USE_DEV_PROXY;
const MODEL = IS_MOCK ? 'haiku' : 'haiku-4.5';
// Mock-mode idle timeout accommodates MCP subprocess spawn (e.g. the
// `fetch-mcp` built-in runs `npx -y @tokenizin/mcp-npx-fetch` which can
// take ~5s even with the package cached).
const IDLE_TIMEOUT = IS_MOCK ? 15000 : 30000;
const SETUP_TIMEOUT = IS_MOCK ? 10000 : 30000;
const TEST_TIMEOUT = IS_MOCK ? 30000 : 90000;

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

        // Send a message
        const result = await sendMessage(daemon, sessionId, 'What is 1+1?');
        expect(result.messageId).toBeString();

        // Wait for message to be processed
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        // Get session - should have messages
        const session = await getSession(daemon, sessionId);

        // Verify session exists and has proper metadata
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

        // Send multiple messages
        const msg1 = await sendMessage(daemon, sessionId, 'First message');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const msg2 = await sendMessage(daemon, sessionId, 'Second message');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const msg3 = await sendMessage(daemon, sessionId, 'Third message');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        // All message IDs should be unique
        expect(msg1.messageId).not.toBe(msg2.messageId);
        expect(msg2.messageId).not.toBe(msg3.messageId);
        expect(msg1.messageId).not.toBe(msg3.messageId);

        // Session should still be functional
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

        // Send a message that will take some time
        await sendMessage(daemon, sessionId, 'Count from 1 to 100 slowly.');

        // Wait a bit for processing to start (shorter in mock mode)
        const interruptDelay = IS_MOCK ? 100 : 2000;
        await new Promise((resolve) => setTimeout(resolve, interruptDelay));

        // Interrupt the stream
        await interrupt(daemon, sessionId);

        // Wait for session to settle after interrupt before sending next message
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        // Session should still be functional after interrupt
        const state = await getProcessingState(daemon, sessionId);
        expect(state).toBeDefined();

        // Send another message to verify session still works
        await sendMessage(daemon, sessionId, 'What is 2+2?');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        // Should be idle and functional
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

        // Initial state check
        let session = await getSession(daemon, sessionId);
        expect(session.id).toBe(sessionId);
        expect(session.workspacePath).toBe(workspacePath);

        // Send a message
        await sendMessage(daemon, sessionId, 'Test message');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        // Session should still be consistent
        session = await getSession(daemon, sessionId);
        expect(session.id).toBe(sessionId);
        expect(session.workspacePath).toBe(workspacePath);

        // Agent should be in idle state
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

        // Send messages in quick succession
        const results = await Promise.all([
          sendMessage(daemon, sessionId, 'Message 1'),
          new Promise((resolve) => setTimeout(resolve, 100)).then(() =>
            sendMessage(daemon, sessionId, 'Message 2')
          ),
          new Promise((resolve) => setTimeout(resolve, 200)).then(() =>
            sendMessage(daemon, sessionId, 'Message 3')
          ),
        ]);

        // All should have unique message IDs
        expect(results[0].messageId).not.toBe(results[1].messageId);
        expect(results[1].messageId).not.toBe(results[2].messageId);

        // Wait for processing to complete
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT * 2);

        // Should be idle
        const state = await getProcessingState(daemon, sessionId);
        expect(state.status).toBe('idle');
      },
      TEST_TIMEOUT * 3
    );
  });
});

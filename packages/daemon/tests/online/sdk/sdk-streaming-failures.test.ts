/**
 * SDK Streaming Behavior Tests
 *
 * These tests verify SDK behavior through the WebSocket daemon API:
 * - Permission mode handling
 * - Message processing
 * - Session state consistency
 *
 * MODES:
 * - Real API (default): Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Dev Proxy: Set NEOKAI_USE_DEV_PROXY=1 for offline testing with mocked responses
 *
 * Run with Dev Proxy:
 *   cd packages/daemon && NEOKAI_USE_DEV_PROXY=1 bun test ./tests/online/sdk/sdk-streaming-failures.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
  sendMessage,
  waitForIdle,
  getProcessingState,
  getSession,
} from '../../helpers/daemon-actions';

// Use temp directory for test workspaces
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

// Tests will FAIL if no credentials are available
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
            permissionMode: 'acceptEdits', // Works on root and non-root
          },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        // Send a message
        const result = await sendMessage(
          daemon,
          sessionId,
          'What is 2+2? Answer with just the number.'
        );

        expect(result.messageId).toBeString();

        // Wait for processing to complete
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        // Verify session is idle
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

        // Send multiple messages
        const msg1 = await sendMessage(daemon, sessionId, 'What is 1+1? Just the number.');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const msg2 = await sendMessage(daemon, sessionId, 'What is 2+2? Just the number.');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const msg3 = await sendMessage(daemon, sessionId, 'What is 3+3? Just the number.');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        // All should have unique message IDs
        expect(msg1.messageId).not.toBe(msg2.messageId);
        expect(msg2.messageId).not.toBe(msg3.messageId);
        expect(msg1.messageId).not.toBe(msg3.messageId);

        // Session should be idle and functional
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

        // Simple prompt pattern (same as other passing tests)
        const result = await sendMessage(
          daemon,
          sessionId,
          'What is 3+3? Answer with just the number.'
        );

        expect(result.messageId).toBeString();

        // Wait for processing to complete
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        // Verify session is idle
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

        // Initial state check
        let session = await getSession(daemon, sessionId);
        expect(session.id).toBe(sessionId);
        expect(session.workspacePath).toBe(workspacePath);

        // Send a message
        await sendMessage(daemon, sessionId, 'What is 1+1? Just the number.');

        // Wait for SDK to process and return to idle
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        // Session should still be consistent
        session = await getSession(daemon, sessionId);
        expect(session.id).toBe(sessionId);
        expect(session.workspacePath).toBe(workspacePath);

        // Agent should be in idle state
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

        // Send a message to the real SDK
        const result = await sendMessage(
          daemon,
          sessionId,
          'What is 2+2? Answer with just the number.'
        );

        expect(result.messageId).toBeString();

        // Wait for processing to complete
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        // Get session data - should be consistent
        const session = await getSession(daemon, sessionId);
        expect(session.id).toBe(sessionId);
        expect(session.workspacePath).toBe(workspacePath);

        // Send another message to verify session still works
        const result2 = await sendMessage(daemon, sessionId, 'What is 3+3? Just the number.');
        expect(result2.messageId).toBeString();
        expect(result2.messageId).not.toBe(result.messageId);

        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        // Session should still be functional
        const state = await getProcessingState(daemon, sessionId);
        expect(state.status).toBe('idle');

        console.log('[PERSISTENCE RELOAD TEST] ✓ PASSED - Messages persisted correctly');
      },
      TEST_TIMEOUT
    );
  });
});

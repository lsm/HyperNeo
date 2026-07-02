/**
 * Selective Rewind Feature Tests
 *
 * These tests verify the selective rewind feature:
 * 1. Selective rewind can delete specific messages and all messages after
 * 2. Mode selection (conversation, both) works correctly
 * 3. Error handling for invalid inputs (empty/nonexistent messageIds)
 * 4. Message count verification after rewind
 *
 * MODES:
 * - Real API (default): Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Dev Proxy: Set HYPERNEO_USE_DEV_PROXY=1 for offline testing with mocked responses
 *
 * Run with Dev Proxy:
 *   cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/rewind/selective-rewind.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';
import type { RewindMode } from '@hyperneo/shared';

/**
 * SDKMessage structure from message.sdkMessages RPC
 */
interface SDKMessageResult {
  uuid: string;
  type: string;
  message?: {
    content?: string | Array<{ type: string; text?: string }>;
  };
  timestamp?: number;
}

/**
 * Selective rewind result
 */
interface SelectiveRewindResult {
  success: boolean;
  error?: string;
  messagesDeleted: number;
  filesReverted?: string[];
  rewindCase?: string;
}

const TMP_DIR = process.env.TMPDIR || '/tmp';

// Detect mock mode for faster timeouts (Dev Proxy)
const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;
const MODEL = IS_MOCK ? 'haiku' : 'haiku-4.5';
const IDLE_TIMEOUT = IS_MOCK ? 10000 : 90000;
const SETUP_TIMEOUT = IS_MOCK ? 15000 : 30000;
const TEST_TIMEOUT = IS_MOCK ? 30000 : 180000;

describe('Selective Rewind Feature', () => {
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

  /**
   * Helper to list messages for a session
   */
  async function listMessages(sessionId: string): Promise<SDKMessageResult[]> {
    const result = (await daemon.messageHub.request('message.sdkMessages', {
      sessionId,
    })) as { sdkMessages: SDKMessageResult[] };
    return result.sdkMessages;
  }

  /**
   * Extract text content from an SDKMessage
   */
  function getMessageText(msg: SDKMessageResult): string {
    if (!msg.message?.content) return '';
    if (typeof msg.message.content === 'string') return msg.message.content;
    if (Array.isArray(msg.message.content)) {
      return msg.message.content
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!)
        .join(' ');
    }
    return '';
  }

  /**
   * Helper to execute selective rewind
   */
  async function executeSelectiveRewind(
    sessionId: string,
    messageIds: string[],
    mode: RewindMode = 'both'
  ): Promise<SelectiveRewindResult> {
    const result = (await daemon.messageHub.request('rewind.executeSelective', {
      sessionId,
      messageIds,
      mode,
    })) as { result: SelectiveRewindResult };
    return result.result;
  }

  describe('Selective Rewind with mode=conversation', () => {
    test('should delete selected messages and all messages after', async () => {
      const workspacePath = `${TMP_DIR}/selective-rewind-conversation-${Date.now()}`;

      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Selective Rewind Conversation Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          enableFileCheckpointing: true,
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      // Send 3 simple messages
      await sendMessage(daemon, sessionId, 'What is 1+1?');
      await waitForIdle(daemon, sessionId, 90000);

      await sendMessage(daemon, sessionId, 'What is 2+2?');
      await waitForIdle(daemon, sessionId, 90000);

      await sendMessage(daemon, sessionId, 'What is 3+3?');
      await waitForIdle(daemon, sessionId, 90000);

      // Get messages
      const messages = await listMessages(sessionId);
      expect(messages.length).toBeGreaterThan(0);

      // Find the 2nd user message (should be "What is 2+2?")
      const userMessages = messages.filter((m) => m.type === 'user');
      expect(userMessages.length).toBeGreaterThanOrEqual(3);

      const secondUserMessage = userMessages.find((m) => getMessageText(m).includes('2+2'));
      expect(secondUserMessage).toBeDefined();

      // Select from 2nd user message onward
      const messageIdsToRewind = [secondUserMessage!.uuid];

      // Execute selective rewind with mode='conversation'
      const result = await executeSelectiveRewind(sessionId, messageIdsToRewind, 'conversation');

      // Verify success
      expect(result.success).toBe(true);
      expect(result.messagesDeleted).toBeGreaterThan(0);

      // Verify selected conversation messages were deleted.
      // Total message count is not stable because query restart can add fresh system messages.
      const messagesAfterRewind = await listMessages(sessionId);

      // Verify the second user message and all after it are gone
      const userMessagesAfter = messagesAfterRewind.filter((m) => m.type === 'user');
      expect(userMessagesAfter.length).toBeLessThan(userMessages.length);
      const hasSecondMessage = userMessagesAfter.some((m) => getMessageText(m).includes('2+2'));
      const hasThirdMessage = userMessagesAfter.some((m) => getMessageText(m).includes('3+3'));
      expect(hasSecondMessage).toBe(false);
      expect(hasThirdMessage).toBe(false);
    }, 300000);
  });

  describe('Selective Rewind with mode=both', () => {
    test('should execute selective rewind with mode=both', async () => {
      const workspacePath = `${TMP_DIR}/selective-rewind-both-${Date.now()}`;

      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Selective Rewind Both Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          enableFileCheckpointing: true,
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      // Send 3 simple messages
      await sendMessage(daemon, sessionId, 'What is 1+1?');
      await waitForIdle(daemon, sessionId, 90000);

      await sendMessage(daemon, sessionId, 'What is 2+2?');
      await waitForIdle(daemon, sessionId, 90000);

      await sendMessage(daemon, sessionId, 'What is 3+3?');
      await waitForIdle(daemon, sessionId, 90000);

      // Get messages
      const messages = await listMessages(sessionId);
      expect(messages.length).toBeGreaterThan(0);

      // Find the 2nd user message
      const userMessages = messages.filter((m) => m.type === 'user');
      expect(userMessages.length).toBeGreaterThanOrEqual(3);

      const secondUserMessage = userMessages.find((m) => getMessageText(m).includes('2+2'));
      expect(secondUserMessage).toBeDefined();

      // Execute selective rewind with mode='both'
      const result = await executeSelectiveRewind(sessionId, [secondUserMessage!.uuid], 'both');

      // Verify success
      expect(result.success).toBe(true);
      expect(result.messagesDeleted).toBeGreaterThan(0);

      // Verify rewindCase is present (3-case selective rewind logic)
      if (result.rewindCase !== undefined) {
        expect(typeof result.rewindCase).toBe('string');
      }

      // Verify selected conversation messages were deleted.
      // Total message count is not stable because query restart can add fresh system messages.
      const messagesAfterRewind = await listMessages(sessionId);
      const userMessagesAfter = messagesAfterRewind.filter((m) => m.type === 'user');
      expect(userMessagesAfter.length).toBeLessThan(userMessages.length);
      const hasSecondMessage = userMessagesAfter.some((m) => getMessageText(m).includes('2+2'));
      expect(hasSecondMessage).toBe(false);
    }, 300000);
  });

  describe('Error Handling', () => {
    test('should fail gracefully with empty messageIds array', async () => {
      const workspacePath = `${TMP_DIR}/selective-rewind-empty-${Date.now()}`;

      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Selective Rewind Empty Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          enableFileCheckpointing: true,
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      // Send a message to initialize
      await sendMessage(daemon, sessionId, 'What is 1+1?');
      await waitForIdle(daemon, sessionId, 60000);

      // Call with empty array
      const result = await executeSelectiveRewind(sessionId, [], 'both');

      // Verify failure
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.messagesDeleted).toBe(0);
    }, 120000);

    test('should handle invalid messageIds gracefully', async () => {
      const workspacePath = `${TMP_DIR}/selective-rewind-invalid-${Date.now()}`;

      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Selective Rewind Invalid Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          enableFileCheckpointing: true,
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      // Send a message to initialize
      await sendMessage(daemon, sessionId, 'What is 1+1?');
      await waitForIdle(daemon, sessionId, 60000);

      // Call with nonexistent UUID
      const result = await executeSelectiveRewind(
        sessionId,
        ['nonexistent-uuid-12345'],
        'conversation'
      );

      // The result depends on implementation - could be success=false or graceful handling
      // Either way, it should not crash
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');

      if (!result.success) {
        // If it fails, should have an error message
        expect(result.error).toBeDefined();
      }

      // Verify session is still functional
      const messages = await listMessages(sessionId);
      expect(messages.length).toBeGreaterThan(0);
    }, 120000);

    test('should handle session not found error', async () => {
      // Call with nonexistent session ID
      const result = await executeSelectiveRewind(
        'nonexistent-session-id',
        ['some-message-id'],
        'both'
      );

      // Should return error
      expect(result.success).toBe(false);
      expect(result.error).toContain('Session not found');
      expect(result.messagesDeleted).toBe(0);
    }, 30000);
  });

  describe('Multiple Message Selection', () => {
    test('should handle multiple messageIds correctly', async () => {
      const workspacePath = `${TMP_DIR}/selective-rewind-multiple-${Date.now()}`;

      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Selective Rewind Multiple Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          enableFileCheckpointing: true,
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      // Send 4 simple messages
      await sendMessage(daemon, sessionId, 'What is 1+1?');
      await waitForIdle(daemon, sessionId, 90000);

      await sendMessage(daemon, sessionId, 'What is 2+2?');
      await waitForIdle(daemon, sessionId, 90000);

      await sendMessage(daemon, sessionId, 'What is 3+3?');
      await waitForIdle(daemon, sessionId, 90000);

      await sendMessage(daemon, sessionId, 'What is 4+4?');
      await waitForIdle(daemon, sessionId, 90000);

      // Get messages
      const messages = await listMessages(sessionId);
      const userMessages = messages.filter((m) => m.type === 'user');
      expect(userMessages.length).toBeGreaterThanOrEqual(4);

      // Select 2nd and 3rd user messages
      const secondUserMessage = userMessages.find((m) => getMessageText(m).includes('2+2'));
      const thirdUserMessage = userMessages.find((m) => getMessageText(m).includes('3+3'));
      expect(secondUserMessage).toBeDefined();
      expect(thirdUserMessage).toBeDefined();

      // Execute selective rewind with multiple messageIds
      // Implementation should find the earliest message and delete from there
      const result = await executeSelectiveRewind(
        sessionId,
        [secondUserMessage!.uuid, thirdUserMessage!.uuid],
        'conversation'
      );

      // Verify success
      expect(result.success).toBe(true);
      expect(result.messagesDeleted).toBeGreaterThan(0);

      // Verify selected conversation messages were deleted from the earliest selected message onward.
      // Total message count is not stable because query restart can add fresh system messages.
      const messagesAfterRewind = await listMessages(sessionId);

      // First message should still be there
      const userMessagesAfter = messagesAfterRewind.filter((m) => m.type === 'user');
      expect(userMessagesAfter.length).toBeLessThan(userMessages.length);
      const hasFirstMessage = userMessagesAfter.some((m) => getMessageText(m).includes('1+1'));
      expect(hasFirstMessage).toBe(true);

      // 2nd, 3rd, and 4th messages should be gone
      const hasSecondMessage = userMessagesAfter.some((m) => getMessageText(m).includes('2+2'));
      const hasThirdMessage = userMessagesAfter.some((m) => getMessageText(m).includes('3+3'));
      const hasFourthMessage = userMessagesAfter.some((m) => getMessageText(m).includes('4+4'));
      expect(hasSecondMessage).toBe(false);
      expect(hasThirdMessage).toBe(false);
      expect(hasFourthMessage).toBe(false);
    }, 360000);
  });

  describe('Non-User Message Rewind', () => {
    test('should rewind to assistant message with multiple tool uses and accept new messages', async () => {
      const workspacePath = `${TMP_DIR}/selective-rewind-nonuser-${Date.now()}`;

      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Non-User Message Rewind Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          enableFileCheckpointing: true,
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      // Send a message that triggers multiple tool uses (Write and Read)
      await sendMessage(
        daemon,
        sessionId,
        'Create a file called test.txt with content "hello world", then read it back to me'
      );
      await waitForIdle(daemon, sessionId, 180000);

      // Get messages
      const messages = await listMessages(sessionId);
      expect(messages.length).toBeGreaterThan(0);

      // Find the assistant message (should have tool use blocks)
      const assistantMessages = messages.filter((m) => m.type === 'assistant');
      expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

      // Use the first assistant message
      const assistantMessage = assistantMessages[0];
      expect(assistantMessage).toBeDefined();

      // Execute selective rewind to the assistant message
      const result = await executeSelectiveRewind(
        sessionId,
        [assistantMessage.uuid],
        'conversation'
      );

      // Verify success
      expect(result.success).toBe(true);
      expect(result.messagesDeleted).toBeGreaterThan(0);

      // Verify the assistant message and messages after it are gone
      const messagesAfterRewind = await listMessages(sessionId);
      const assistantMessagesAfter = messagesAfterRewind.filter((m) => m.type === 'assistant');

      // The assistant message we rewound to should be deleted
      const hasOriginalAssistant = assistantMessagesAfter.some(
        (m) => m.uuid === assistantMessage.uuid
      );
      expect(hasOriginalAssistant).toBe(false);

      // Send a new message to verify SDK still accepts messages after non-native rewind
      await sendMessage(daemon, sessionId, 'What is 2+2?');
      await waitForIdle(daemon, sessionId, 180000);

      // Verify new message was processed
      const messagesAfterNew = await listMessages(sessionId);
      const hasNewMessage = messagesAfterNew.some((m) => getMessageText(m).includes('2+2'));
      expect(hasNewMessage).toBe(true);

      // Verify the session is still functional (has at least a user message)
      const userMessagesAfterNew = messagesAfterNew.filter((m) => m.type === 'user');
      expect(userMessagesAfterNew.length).toBeGreaterThan(0);
    }, 360000);
  });
});

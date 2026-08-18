import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';
import type { RewindMode } from '@hyperneo/shared';

interface SDKMessageResult {
  uuid: string;
  type: string;
  message?: {
    content?: string | Array<{ type: string; text?: string }>;
  };
  timestamp?: number;
}

interface SelectiveRewindResult {
  success: boolean;
  error?: string;
  messagesDeleted: number;
  filesReverted?: string[];
  rewindCase?: string;
}

const TMP_DIR = process.env.TMPDIR || '/tmp';

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

  async function listMessages(sessionId: string): Promise<SDKMessageResult[]> {
    const result = (await daemon.messageHub.request('message.sdkMessages', {
      sessionId,
    })) as { sdkMessages: SDKMessageResult[] };
    return result.sdkMessages;
  }

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

      await sendMessage(daemon, sessionId, 'What is 1+1?');
      await waitForIdle(daemon, sessionId, 90000);

      await sendMessage(daemon, sessionId, 'What is 2+2?');
      await waitForIdle(daemon, sessionId, 90000);

      await sendMessage(daemon, sessionId, 'What is 3+3?');
      await waitForIdle(daemon, sessionId, 90000);

      const messages = await listMessages(sessionId);
      expect(messages.length).toBeGreaterThan(0);

      const userMessages = messages.filter((m) => m.type === 'user');
      expect(userMessages.length).toBeGreaterThanOrEqual(3);

      const secondUserMessage = userMessages.find((m) => getMessageText(m).includes('2+2'));
      expect(secondUserMessage).toBeDefined();

      const messageIdsToRewind = [secondUserMessage!.uuid];

      const result = await executeSelectiveRewind(sessionId, messageIdsToRewind, 'conversation');

      expect(result.success).toBe(true);
      expect(result.messagesDeleted).toBeGreaterThan(0);

      const messagesAfterRewind = await listMessages(sessionId);

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

      await sendMessage(daemon, sessionId, 'What is 1+1?');
      await waitForIdle(daemon, sessionId, 90000);

      await sendMessage(daemon, sessionId, 'What is 2+2?');
      await waitForIdle(daemon, sessionId, 90000);

      await sendMessage(daemon, sessionId, 'What is 3+3?');
      await waitForIdle(daemon, sessionId, 90000);

      const messages = await listMessages(sessionId);
      expect(messages.length).toBeGreaterThan(0);

      const userMessages = messages.filter((m) => m.type === 'user');
      expect(userMessages.length).toBeGreaterThanOrEqual(3);

      const secondUserMessage = userMessages.find((m) => getMessageText(m).includes('2+2'));
      expect(secondUserMessage).toBeDefined();

      const result = await executeSelectiveRewind(sessionId, [secondUserMessage!.uuid], 'both');

      expect(result.success).toBe(true);
      expect(result.messagesDeleted).toBeGreaterThan(0);

      if (result.rewindCase !== undefined) {
        expect(typeof result.rewindCase).toBe('string');
      }

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

      await sendMessage(daemon, sessionId, 'What is 1+1?');
      await waitForIdle(daemon, sessionId, 60000);

      const result = await executeSelectiveRewind(sessionId, [], 'both');

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

      await sendMessage(daemon, sessionId, 'What is 1+1?');
      await waitForIdle(daemon, sessionId, 60000);

      const result = await executeSelectiveRewind(
        sessionId,
        ['nonexistent-uuid-12345'],
        'conversation'
      );

      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');

      if (!result.success) {
        expect(result.error).toBeDefined();
      }

      const messages = await listMessages(sessionId);
      expect(messages.length).toBeGreaterThan(0);
    }, 120000);

    test('should handle session not found error', async () => {
      const result = await executeSelectiveRewind(
        'nonexistent-session-id',
        ['some-message-id'],
        'both'
      );

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

      await sendMessage(daemon, sessionId, 'What is 1+1?');
      await waitForIdle(daemon, sessionId, 90000);

      await sendMessage(daemon, sessionId, 'What is 2+2?');
      await waitForIdle(daemon, sessionId, 90000);

      await sendMessage(daemon, sessionId, 'What is 3+3?');
      await waitForIdle(daemon, sessionId, 90000);

      await sendMessage(daemon, sessionId, 'What is 4+4?');
      await waitForIdle(daemon, sessionId, 90000);

      const messages = await listMessages(sessionId);
      const userMessages = messages.filter((m) => m.type === 'user');
      expect(userMessages.length).toBeGreaterThanOrEqual(4);

      const secondUserMessage = userMessages.find((m) => getMessageText(m).includes('2+2'));
      const thirdUserMessage = userMessages.find((m) => getMessageText(m).includes('3+3'));
      expect(secondUserMessage).toBeDefined();
      expect(thirdUserMessage).toBeDefined();

      const result = await executeSelectiveRewind(
        sessionId,
        [secondUserMessage!.uuid, thirdUserMessage!.uuid],
        'conversation'
      );

      expect(result.success).toBe(true);
      expect(result.messagesDeleted).toBeGreaterThan(0);

      const messagesAfterRewind = await listMessages(sessionId);

      const userMessagesAfter = messagesAfterRewind.filter((m) => m.type === 'user');
      expect(userMessagesAfter.length).toBeLessThan(userMessages.length);
      const hasFirstMessage = userMessagesAfter.some((m) => getMessageText(m).includes('1+1'));
      expect(hasFirstMessage).toBe(true);

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

      await sendMessage(
        daemon,
        sessionId,
        'Create a file called test.txt with content "hello world", then read it back to me'
      );
      await waitForIdle(daemon, sessionId, 180000);

      const messages = await listMessages(sessionId);
      expect(messages.length).toBeGreaterThan(0);

      const assistantMessages = messages.filter((m) => m.type === 'assistant');
      expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

      const assistantMessage = assistantMessages[0];
      expect(assistantMessage).toBeDefined();

      const result = await executeSelectiveRewind(
        sessionId,
        [assistantMessage.uuid],
        'conversation'
      );

      expect(result.success).toBe(true);
      expect(result.messagesDeleted).toBeGreaterThan(0);

      const messagesAfterRewind = await listMessages(sessionId);
      const assistantMessagesAfter = messagesAfterRewind.filter((m) => m.type === 'assistant');

      const hasOriginalAssistant = assistantMessagesAfter.some(
        (m) => m.uuid === assistantMessage.uuid
      );
      expect(hasOriginalAssistant).toBe(false);

      await sendMessage(daemon, sessionId, 'What is 2+2?');
      await waitForIdle(daemon, sessionId, 180000);

      const messagesAfterNew = await listMessages(sessionId);
      const hasNewMessage = messagesAfterNew.some((m) => getMessageText(m).includes('2+2'));
      expect(hasNewMessage).toBe(true);

      const userMessagesAfterNew = messagesAfterNew.filter((m) => m.type === 'user');
      expect(userMessagesAfterNew.length).toBeGreaterThan(0);
    }, 360000);
  });
});

/**
 * MessageRecoveryHandler Tests
 *
 * Tests for recovering orphaned messages.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { MessageRecoveryHandler } from '../../../../src/lib/agent/message-recovery-handler';
import type { Session } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import type { Database } from '../../../../src/storage/database';
import type { Logger } from '../../../../src/lib/logger';

describe('MessageRecoveryHandler', () => {
  let handler: MessageRecoveryHandler;
  let mockSession: Session;
  let mockDb: Database;
  let mockLogger: Logger;

  let getMessagesByStatusSpy: ReturnType<typeof mock>;
  let getLatestSystemInitTimestampSpy: ReturnType<typeof mock>;
  let updateMessageStatusSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    mockSession = {
      id: 'test-session-id',
      title: 'Test Session',
      workspacePath: '/test/path',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: {
        model: 'default',
        maxTokens: 8192,
        temperature: 1.0,
      },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
      },
    };

    getMessagesByStatusSpy = mock(() => []);
    getLatestSystemInitTimestampSpy = mock(() => 0);
    updateMessageStatusSpy = mock(() => {});
    mockDb = {
      getMessagesByStatus: getMessagesByStatusSpy,
      getLatestSystemInitTimestamp: getLatestSystemInitTimestampSpy,
      updateMessageStatus: updateMessageStatusSpy,
    } as unknown as Database;

    mockLogger = {
      log: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
      info: mock(() => {}),
    } as unknown as Logger;

    handler = new MessageRecoveryHandler(mockSession, mockDb, mockLogger);
  });

  describe('constructor', () => {
    it('should create handler with dependencies', () => {
      expect(handler).toBeDefined();
    });
  });

  describe('recoverOrphanedConsumedMessages', () => {
    it('should return early if no stuck messages', () => {
      getMessagesByStatusSpy.mockReturnValue([]);

      handler.recoverOrphanedConsumedMessages();

      expect(getLatestSystemInitTimestampSpy).not.toHaveBeenCalled();
      expect(updateMessageStatusSpy).not.toHaveBeenCalled();
    });

    it('should check consumed messages for recovery', () => {
      getMessagesByStatusSpy.mockReturnValue([]);

      handler.recoverOrphanedConsumedMessages();

      expect(getMessagesByStatusSpy).toHaveBeenCalledWith('test-session-id', 'consumed');
    });

    it('should find orphaned user messages without system:init response', () => {
      const sentUserMessage: SDKMessage = {
        dbId: 'db-1',
        uuid: 'uuid-12345678',
        type: 'user',
        message: { role: 'user', content: 'Hello' },
        timestamp: 2000,
      } as unknown as SDKMessage;

      getMessagesByStatusSpy.mockReturnValue([sentUserMessage]);

      getLatestSystemInitTimestampSpy.mockReturnValue(1000);

      handler.recoverOrphanedConsumedMessages();

      // User message timestamp (2000) > system:init timestamp (1000) = orphaned
      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1'], 'failed');
    });

    it('should not recover consumed messages that have system:init after them', () => {
      const sentUserMessage: SDKMessage = {
        dbId: 'db-1',
        uuid: 'uuid-12345678',
        type: 'user',
        message: { role: 'user', content: 'Hello' },
        timestamp: 1000,
      } as unknown as SDKMessage;

      getMessagesByStatusSpy.mockReturnValue([sentUserMessage]);

      getLatestSystemInitTimestampSpy.mockReturnValue(2000);

      handler.recoverOrphanedConsumedMessages();

      // User message timestamp (1000) < system:init timestamp (2000) = not orphaned
      expect(updateMessageStatusSpy).not.toHaveBeenCalled();
    });

    it('should not rewrite queued messages during recovery', () => {
      getMessagesByStatusSpy.mockReturnValue([]);
      getLatestSystemInitTimestampSpy.mockReturnValue(0);

      handler.recoverOrphanedConsumedMessages();

      expect(getMessagesByStatusSpy).not.toHaveBeenCalledWith('test-session-id', 'enqueued');
      expect(updateMessageStatusSpy).not.toHaveBeenCalled();
    });

    it('should skip non-user messages', () => {
      const assistantMessage: SDKMessage = {
        dbId: 'db-1',
        uuid: 'uuid-12345678',
        type: 'assistant',
        message: { role: 'assistant', content: [] },
        timestamp: 2000,
      } as unknown as SDKMessage;

      getMessagesByStatusSpy.mockReturnValue([assistantMessage]);

      getLatestSystemInitTimestampSpy.mockReturnValue(0);

      handler.recoverOrphanedConsumedMessages();

      expect(updateMessageStatusSpy).not.toHaveBeenCalled();
    });

    it('should recover multiple orphaned messages', () => {
      const sentMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-11111111',
          type: 'user',
          message: { role: 'user', content: 'First' },
          timestamp: 2000,
        } as unknown as SDKMessage,
        {
          dbId: 'db-2',
          uuid: 'uuid-22222222',
          type: 'user',
          message: { role: 'user', content: 'Second' },
          timestamp: 3000,
        } as unknown as SDKMessage,
      ];

      getMessagesByStatusSpy.mockReturnValue(sentMessages);

      getLatestSystemInitTimestampSpy.mockReturnValue(1000);

      handler.recoverOrphanedConsumedMessages();

      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1', 'db-2'], 'failed');
    });

    it('should handle errors gracefully', () => {
      getMessagesByStatusSpy.mockImplementation(() => {
        throw new Error('Database error');
      });

      // Should not throw
      handler.recoverOrphanedConsumedMessages();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to mark orphaned consumed messages as failed:',
        expect.any(Error)
      );
    });

    it('should handle consumed messages without timestamps', () => {
      const sentUserMessage: SDKMessage = {
        dbId: 'db-1',
        uuid: 'uuid-12345678',
        type: 'user',
        message: { role: 'user', content: 'Hello' },
        // No timestamp
      } as unknown as SDKMessage;

      getMessagesByStatusSpy.mockReturnValue([sentUserMessage]);

      getLatestSystemInitTimestampSpy.mockReturnValue(0);

      handler.recoverOrphanedConsumedMessages();

      // With no system:init (latestInitTimestamp = 0) and message timestamp = 0,
      // the message is NOT orphaned (0 > 0 is false)
      expect(updateMessageStatusSpy).not.toHaveBeenCalled();
    });

    it('should handle messages without uuid', () => {
      const sentUserMessage: SDKMessage = {
        dbId: 'db-1',
        // No uuid
        type: 'user',
        message: { role: 'user', content: 'Hello' },
        timestamp: 2000,
      } as unknown as SDKMessage;

      getMessagesByStatusSpy.mockReturnValue([sentUserMessage]);

      getLatestSystemInitTimestampSpy.mockReturnValue(0);

      handler.recoverOrphanedConsumedMessages();

      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1'], 'failed');
    });

    it('should skip synthetic messages (isSynthetic=true)', () => {
      const syntheticMessage: SDKMessage = {
        dbId: 'db-1',
        uuid: 'uuid-12345678',
        type: 'user',
        isSynthetic: true,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'result' }],
        },
        timestamp: 2000,
      } as unknown as SDKMessage;

      getMessagesByStatusSpy.mockReturnValue([syntheticMessage]);

      getLatestSystemInitTimestampSpy.mockReturnValue(1000);

      handler.recoverOrphanedConsumedMessages();

      // Synthetic messages should never be recovered
      expect(updateMessageStatusSpy).not.toHaveBeenCalled();
    });

    it('should skip messages with only tool_result content blocks', () => {
      const toolResultMessage: SDKMessage = {
        dbId: 'db-1',
        uuid: 'uuid-12345678',
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'result 1' },
            { type: 'tool_result', tool_use_id: 'tu-2', content: 'result 2' },
          ],
        },
        timestamp: 2000,
      } as unknown as SDKMessage;

      getMessagesByStatusSpy.mockReturnValue([toolResultMessage]);

      getLatestSystemInitTimestampSpy.mockReturnValue(1000);

      handler.recoverOrphanedConsumedMessages();

      // tool_result-only messages are not human-typed, should not be recovered
      expect(updateMessageStatusSpy).not.toHaveBeenCalled();
    });

    it('should recover messages with mixed text and tool_result content', () => {
      const mixedMessage: SDKMessage = {
        dbId: 'db-1',
        uuid: 'uuid-12345678',
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Here is my answer:' },
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'result' },
          ],
        },
        timestamp: 2000,
      } as unknown as SDKMessage;

      getMessagesByStatusSpy.mockReturnValue([mixedMessage]);

      getLatestSystemInitTimestampSpy.mockReturnValue(1000);

      handler.recoverOrphanedConsumedMessages();

      // Mixed content has human-typed text, should be recovered
      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1'], 'failed');
    });

    it('should find latest system:init timestamp for consumed messages', () => {
      const sentUserMessage: SDKMessage = {
        dbId: 'db-1',
        uuid: 'uuid-12345678',
        type: 'user',
        message: { role: 'user', content: 'Hello' },
        timestamp: 2500,
      } as unknown as SDKMessage;

      getMessagesByStatusSpy.mockReturnValue([sentUserMessage]);

      getLatestSystemInitTimestampSpy.mockReturnValue(3000);

      handler.recoverOrphanedConsumedMessages();

      // User message timestamp (2500) < latest system:init (3000) = not orphaned
      expect(updateMessageStatusSpy).not.toHaveBeenCalled();
    });
  });
});

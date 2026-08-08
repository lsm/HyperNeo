/**
 * MessageRecoveryHandler Tests
 *
 * Tests for recovering orphaned messages.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { MessageRecoveryHandler } from '../../../../src/lib/agent/message-recovery-handler';
import type { Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { Database } from '../../../../src/storage/database';
import type { Logger } from '../../../../src/lib/logger';

describe('MessageRecoveryHandler', () => {
  let handler: MessageRecoveryHandler;
  let mockSession: Session;
  let mockDb: Database;
  let mockLogger: Logger;

  let getConsumedUserMessagesAfterLatestInitSpy: ReturnType<typeof mock>;
  let getMessagesByStatusSpy: ReturnType<typeof mock>;
  let getLatestSystemInitTimestampSpy: ReturnType<typeof mock>;
  let updateMessageStatusSpy: ReturnType<typeof mock>;
  let recordLifecycleSpy: ReturnType<typeof mock>;
  let getLatestStageSpy: ReturnType<typeof mock>;
  let lifecycleReadableSpy: ReturnType<typeof mock>;

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

    getConsumedUserMessagesAfterLatestInitSpy = mock(() => []);
    getMessagesByStatusSpy = mock(() => []);
    getLatestSystemInitTimestampSpy = mock(() => 0);
    updateMessageStatusSpy = mock(() => {});
    recordLifecycleSpy = mock(() => {});
    getLatestStageSpy = mock(() => ({ ok: true, value: null }));
    lifecycleReadableSpy = mock(() => true);
    mockDb = {
      getConsumedUserMessagesAfterLatestInit: getConsumedUserMessagesAfterLatestInitSpy,
      getMessagesByStatus: getMessagesByStatusSpy,
      getLatestSystemInitTimestamp: getLatestSystemInitTimestampSpy,
      updateMessageStatus: updateMessageStatusSpy,
      messageDeliveryLifecycle: {
        record: recordLifecycleSpy,
        getLatestStage: getLatestStageSpy,
        isReadable: lifecycleReadableSpy,
      },
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
      getConsumedUserMessagesAfterLatestInitSpy.mockReturnValue([]);

      handler.recoverOrphanedConsumedMessages();

      expect(getConsumedUserMessagesAfterLatestInitSpy).toHaveBeenCalledWith('test-session-id');
      expect(getMessagesByStatusSpy).not.toHaveBeenCalled();
      expect(getLatestSystemInitTimestampSpy).not.toHaveBeenCalled();
      expect(updateMessageStatusSpy).not.toHaveBeenCalled();
    });

    it('should check consumed messages for recovery', () => {
      getConsumedUserMessagesAfterLatestInitSpy.mockReturnValue([]);

      handler.recoverOrphanedConsumedMessages();

      expect(getConsumedUserMessagesAfterLatestInitSpy).toHaveBeenCalledWith('test-session-id');
    });

    it('should find orphaned user messages without system:init response', () => {
      const sentUserMessage: SDKMessage = {
        dbId: 'db-1',
        uuid: 'uuid-12345678',
        type: 'user',
        message: { role: 'user', content: 'Hello' },
        timestamp: 2000,
      } as unknown as SDKMessage;

      getConsumedUserMessagesAfterLatestInitSpy.mockReturnValue([sentUserMessage]);

      getLatestSystemInitTimestampSpy.mockReturnValue(1000);

      handler.recoverOrphanedConsumedMessages();

      expect(getMessagesByStatusSpy).not.toHaveBeenCalled();
      expect(getLatestSystemInitTimestampSpy).not.toHaveBeenCalled();
      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1'], 'failed');
    });

    it('should rely on the repository to filter messages before the latest system:init', () => {
      getConsumedUserMessagesAfterLatestInitSpy.mockReturnValue([]);

      handler.recoverOrphanedConsumedMessages();

      expect(getConsumedUserMessagesAfterLatestInitSpy).toHaveBeenCalledWith('test-session-id');
      expect(getMessagesByStatusSpy).not.toHaveBeenCalled();
      expect(getLatestSystemInitTimestampSpy).not.toHaveBeenCalled();
      expect(updateMessageStatusSpy).not.toHaveBeenCalled();
    });

    it('should not rewrite queued messages during recovery', () => {
      getConsumedUserMessagesAfterLatestInitSpy.mockReturnValue([]);
      getLatestSystemInitTimestampSpy.mockReturnValue(0);

      handler.recoverOrphanedConsumedMessages();

      expect(getConsumedUserMessagesAfterLatestInitSpy).toHaveBeenCalledWith('test-session-id');
      expect(getMessagesByStatusSpy).not.toHaveBeenCalled();
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

      getConsumedUserMessagesAfterLatestInitSpy.mockReturnValue([assistantMessage]);

      getLatestSystemInitTimestampSpy.mockReturnValue(0);

      handler.recoverOrphanedConsumedMessages();

      expect(getLatestSystemInitTimestampSpy).not.toHaveBeenCalled();
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

      getConsumedUserMessagesAfterLatestInitSpy.mockReturnValue(sentMessages);

      getLatestSystemInitTimestampSpy.mockReturnValue(1000);

      handler.recoverOrphanedConsumedMessages();

      expect(getLatestSystemInitTimestampSpy).not.toHaveBeenCalled();
      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1', 'db-2'], 'failed');
    });

    it('should handle errors gracefully', () => {
      getConsumedUserMessagesAfterLatestInitSpy.mockImplementation(() => {
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

      getConsumedUserMessagesAfterLatestInitSpy.mockReturnValue([sentUserMessage]);

      getLatestSystemInitTimestampSpy.mockReturnValue(0);

      handler.recoverOrphanedConsumedMessages();

      expect(getLatestSystemInitTimestampSpy).not.toHaveBeenCalled();
      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1'], 'failed');
    });

    it('should handle messages without uuid', () => {
      const sentUserMessage: SDKMessage = {
        dbId: 'db-1',
        // No uuid
        type: 'user',
        message: { role: 'user', content: 'Hello' },
        timestamp: 2000,
      } as unknown as SDKMessage;

      getConsumedUserMessagesAfterLatestInitSpy.mockReturnValue([sentUserMessage]);

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

      getConsumedUserMessagesAfterLatestInitSpy.mockReturnValue([syntheticMessage]);

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

      getConsumedUserMessagesAfterLatestInitSpy.mockReturnValue([toolResultMessage]);

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

      getConsumedUserMessagesAfterLatestInitSpy.mockReturnValue([mixedMessage]);

      getLatestSystemInitTimestampSpy.mockReturnValue(1000);

      handler.recoverOrphanedConsumedMessages();

      // Mixed content has human-typed text, should be recovered
      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1'], 'failed');
    });

    it('should not load all consumed messages or compute latest system:init in the handler', () => {
      const sentUserMessage: SDKMessage = {
        dbId: 'db-1',
        uuid: 'uuid-12345678',
        type: 'user',
        message: { role: 'user', content: 'Hello' },
        timestamp: 2500,
      } as unknown as SDKMessage;

      getConsumedUserMessagesAfterLatestInitSpy.mockReturnValue([sentUserMessage]);

      getLatestSystemInitTimestampSpy.mockReturnValue(3000);

      handler.recoverOrphanedConsumedMessages();

      expect(getConsumedUserMessagesAfterLatestInitSpy).toHaveBeenCalledWith('test-session-id');
      expect(getMessagesByStatusSpy).not.toHaveBeenCalled();
      expect(getLatestSystemInitTimestampSpy).not.toHaveBeenCalled();
      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1'], 'failed');
    });

    it('records a failed delivery-lifecycle event for each recovered orphan (task #859)', () => {
      const orphanA: SDKMessage = {
        dbId: 'db-1',
        uuid: 'uuid-aaaaaaaa',
        type: 'user',
        message: { role: 'user', content: 'First' },
        timestamp: 2000,
      } as unknown as SDKMessage;
      const orphanB: SDKMessage = {
        dbId: 'db-2',
        uuid: 'uuid-bbbbbbbb',
        type: 'user',
        message: { role: 'user', content: 'Second' },
        timestamp: 3000,
      } as unknown as SDKMessage;

      getConsumedUserMessagesAfterLatestInitSpy.mockReturnValue([orphanA, orphanB]);

      handler.recoverOrphanedConsumedMessages();

      // Each orphan gets a `failed` lifecycle event keyed by its stable UUID,
      // with reason 'orphaned_after_restart' so the stranded shape is queryable.
      expect(recordLifecycleSpy).toHaveBeenCalledWith(
        'test-session-id',
        'uuid-aaaaaaaa',
        'failed',
        { reason: 'orphaned_after_restart' }
      );
      expect(recordLifecycleSpy).toHaveBeenCalledWith(
        'test-session-id',
        'uuid-bbbbbbbb',
        'failed',
        { reason: 'orphaned_after_restart' }
      );
    });

    it('skips messages already terminal in the ledger (N6/F13)', () => {
      const completed = {
        dbId: 'db-done',
        uuid: 'uuid-done',
        type: 'user',
        message: { role: 'user', content: 'done' },
        timestamp: 2000,
      } as unknown as SDKMessage;
      const realOrphan = {
        dbId: 'db-orphan',
        uuid: 'uuid-orphan',
        type: 'user',
        message: { role: 'user', content: 'lost' },
        timestamp: 3000,
      } as unknown as SDKMessage;

      getConsumedUserMessagesAfterLatestInitSpy.mockReturnValue([completed, realOrphan]);
      // The completed message already reached a terminal lifecycle stage; the
      // orphan has no lifecycle record.
      getLatestStageSpy.mockImplementation((id: string) =>
        id === 'uuid-done'
          ? { ok: true, value: { stage: 'completed', createdAt: 1 } }
          : { ok: true, value: null }
      );

      handler.recoverOrphanedConsumedMessages();

      // Only the real orphan is marked failed; the completed one is left alone.
      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-orphan'], 'failed');
      expect(updateMessageStatusSpy).not.toHaveBeenCalledWith(['db-done'], 'failed');
      expect(recordLifecycleSpy).toHaveBeenCalledWith('test-session-id', 'uuid-orphan', 'failed', {
        reason: 'orphaned_after_restart',
      });
      expect(recordLifecycleSpy).not.toHaveBeenCalledWith(
        'test-session-id',
        'uuid-done',
        'failed',
        expect.anything()
      );
    });

    it('skips real-UUID candidates when the ledger is unreadable (round-13)', () => {
      const delivered = {
        dbId: 'db-done',
        uuid: 'uuid-done',
        type: 'user',
        message: { role: 'user', content: 'done' },
        timestamp: 2000,
      } as unknown as SDKMessage;
      const legacy = {
        dbId: 'db-legacy',
        uuid: 'unknown',
        type: 'user',
        message: { role: 'user', content: 'legacy' },
        timestamp: 3000,
      } as unknown as SDKMessage;

      getConsumedUserMessagesAfterLatestInitSpy.mockReturnValue([delivered, legacy]);
      // A corrupt ledger makes getLatestStage return null (its internal catch) —
      // which must NOT read as "no evidence" for real-UUID candidates.
      lifecycleReadableSpy.mockReturnValue(false);

      handler.recoverOrphanedConsumedMessages();

      // The real-UUID candidate is left alone (the ledger meant to protect it
      // could not be read); only the UUID-less legacy row recovers as before.
      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-legacy'], 'failed');
      expect(updateMessageStatusSpy).not.toHaveBeenCalledWith(['db-done'], 'failed');
      expect(recordLifecycleSpy).not.toHaveBeenCalledWith(
        'test-session-id',
        'uuid-done',
        'failed',
        expect.anything()
      );
    });

    it('skips real-UUID candidates when the per-message lookup fails (round-15)', () => {
      const delivered = {
        dbId: 'db-done',
        uuid: 'uuid-done',
        type: 'user',
        message: { role: 'user', content: 'done' },
        timestamp: 2000,
      } as unknown as SDKMessage;

      getConsumedUserMessagesAfterLatestInitSpy.mockReturnValue([delivered]);
      // The table-level probe passes, but the message_id-index lookup that
      // getLatestStage walks fails — the probe cannot see that corruption. The
      // distinct { ok: false } result must still prevent a destructive fail.
      lifecycleReadableSpy.mockReturnValue(true);
      getLatestStageSpy.mockReturnValue({ ok: false });

      handler.recoverOrphanedConsumedMessages();

      expect(updateMessageStatusSpy).not.toHaveBeenCalledWith(['db-done'], 'failed');
      expect(recordLifecycleSpy).not.toHaveBeenCalledWith(
        'test-session-id',
        'uuid-done',
        'failed',
        expect.anything()
      );
    });
  });
});

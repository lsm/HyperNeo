import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { Session } from '@hyperneo/shared';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueryLifecycleManager } from '../../../../src/lib/agent/query-lifecycle-manager';
import {
  RewindHandler,
  type RewindHandlerContext,
  type RewindPoint,
} from '../../../../src/lib/agent/rewind-handler';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Logger } from '../../../../src/lib/logger';
import type { Database } from '../../../../src/storage/database';

describe('RewindHandler', () => {
  let handler: RewindHandler;
  let mockSession: Session;
  let mockDb: Database;
  let mockDaemonHub: DaemonHub;
  let mockInternalEventBus: InternalEventBus<any>;
  let mockLifecycleManager: QueryLifecycleManager;
  let mockLogger: Logger;
  let mockQueryObject: Query | null;

  let emitSpy: ReturnType<typeof mock>;
  let getUserMessagesSpy: ReturnType<typeof mock>;
  let getUserMessageByUuidSpy: ReturnType<typeof mock>;
  let countMessagesAfterSpy: ReturnType<typeof mock>;
  let restartSpy: ReturnType<typeof mock>;
  let deleteMessagesAfterSpy: ReturnType<typeof mock>;
  let deleteMessagesAtAndAfterSpy: ReturnType<typeof mock>;
  let rewindFilesSpy: ReturnType<typeof mock>;
  let updateSessionSpy: ReturnType<typeof mock>;
  let setPendingResumeSessionAtSpy: ReturnType<typeof mock>;
  let clearPendingResumeSessionAtSpy: ReturnType<typeof mock>;
  let testSdkSessionDir: string;
  let originalTestSdkSessionDir: string | undefined;

  const testTimestamp = Date.now();
  const testRewindPoint: RewindPoint = {
    uuid: 'message-uuid-123',
    content: 'Test message',
    turnNumber: 1,
    timestamp: testTimestamp,
  };

  beforeEach(() => {
    mockSession = {
      id: 'test-session-id',
      title: 'Test Session',
      workspacePath: '/test/path',
      sdkSessionId: 'test-sdk-session-id',
      status: 'active',
      config: { model: 'claude-sonnet-4-20250514' },
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as Session;

    emitSpy = mock(async () => {});
    mockInternalEventBus = {
      publish: emitSpy,
      publishAsync: emitSpy,
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;
    mockDaemonHub = {
      emit: emitSpy,
    } as unknown as DaemonHub;

    deleteMessagesAfterSpy = mock(() => 5);
    deleteMessagesAtAndAfterSpy = mock(() => 5);
    updateSessionSpy = mock(() => {});
    setPendingResumeSessionAtSpy = mock(() => {});
    clearPendingResumeSessionAtSpy = mock(() => {});
    getUserMessagesSpy = mock(() => [
      {
        uuid: testRewindPoint.uuid,
        content: testRewindPoint.content,
        timestamp: testRewindPoint.timestamp,
      },
    ]);
    getUserMessageByUuidSpy = mock((_sessionId: string, uuid: string) =>
      uuid === testRewindPoint.uuid ? testRewindPoint : undefined
    );
    countMessagesAfterSpy = mock(() => 5);
    mockDb = {
      deleteMessagesAfter: deleteMessagesAfterSpy,
      deleteMessagesAtAndAfter: deleteMessagesAtAndAfterSpy,
      updateSession: updateSessionSpy,
      getUserMessages: getUserMessagesSpy,
      getUserMessageByUuid: getUserMessageByUuidSpy,
      countMessagesAfter: countMessagesAfterSpy,
      getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
    } as unknown as Database;

    restartSpy = mock(async () => {});
    mockLifecycleManager = {
      restart: restartSpy,
    } as unknown as QueryLifecycleManager;

    mockLogger = {
      log: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
      info: mock(() => {}),
    } as unknown as Logger;

    rewindFilesSpy = mock(async () => ({
      canRewind: true,
      filesChanged: ['file1.ts', 'file2.ts'],
      insertions: 10,
      deletions: 5,
    }));
    mockQueryObject = {
      rewindFiles: rewindFilesSpy,
    } as unknown as Query;

    originalTestSdkSessionDir = process.env.TEST_SDK_SESSION_DIR;
    testSdkSessionDir = join(
      tmpdir(),
      `rewind-sdk-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.TEST_SDK_SESSION_DIR = testSdkSessionDir;
  });

  afterEach(() => {
    if (existsSync(testSdkSessionDir)) {
      rmSync(testSdkSessionDir, { recursive: true, force: true });
    }

    if (originalTestSdkSessionDir !== undefined) {
      process.env.TEST_SDK_SESSION_DIR = originalTestSdkSessionDir;
    } else {
      delete process.env.TEST_SDK_SESSION_DIR;
    }
  });

  function createContext(overrides: Partial<RewindHandlerContext> = {}): RewindHandlerContext {
    return {
      session: mockSession,
      db: mockDb,
      daemonHub: mockDaemonHub,
      internalEventBus: mockInternalEventBus,
      lifecycleManager: mockLifecycleManager,
      logger: mockLogger,
      queryObject: mockQueryObject,
      firstMessageReceived: true,
      setPendingResumeSessionAt: setPendingResumeSessionAtSpy,
      clearPendingResumeSessionAt: clearPendingResumeSessionAtSpy,
      ...overrides,
    };
  }

  function createHandler(overrides: Partial<RewindHandlerContext> = {}): RewindHandler {
    return new RewindHandler(createContext(overrides));
  }

  function writeSdkTranscript(uuids: string[], session = mockSession): void {
    const workspacePath = session.worktree ? session.worktree.worktreePath : session.workspacePath;
    if (!workspacePath || !session.sdkSessionId) {
      throw new Error('Test session requires workspacePath and sdkSessionId');
    }

    const projectKey = workspacePath.replace(/[/.]/g, '-');
    const sessionDir = join(testSdkSessionDir, 'projects', projectKey);
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, `${session.sdkSessionId}.jsonl`);
    const lines = uuids.map((uuid) =>
      JSON.stringify({
        type: 'user',
        uuid,
        sessionId: session.id,
        message: { role: 'user', content: [{ type: 'text', text: uuid }] },
      })
    );
    writeFileSync(sessionFile, lines.join('\n') + '\n', 'utf-8');
  }

  describe('constructor', () => {
    it('should create handler with context', () => {
      handler = createHandler();
      expect(handler).toBeDefined();
    });
  });

  describe('getRewindPoints', () => {
    it('should get user messages from DB and add turn numbers', () => {
      handler = createHandler();
      const rewindPoints = handler.getRewindPoints();

      expect(getUserMessagesSpy).toHaveBeenCalledWith(mockSession.id);
      expect(rewindPoints).toEqual([
        {
          uuid: testRewindPoint.uuid,
          content: testRewindPoint.content,
          timestamp: testRewindPoint.timestamp,
          turnNumber: 1,
        },
      ]);
    });

    it('should reverse the order so newest is first', () => {
      getUserMessagesSpy.mockReturnValue([
        {
          uuid: 'msg-1',
          content: 'First',
          timestamp: 1000,
        },
        {
          uuid: 'msg-2',
          content: 'Second',
          timestamp: 2000,
        },
        {
          uuid: 'msg-3',
          content: 'Third',
          timestamp: 3000,
        },
      ]);

      handler = createHandler();
      const rewindPoints = handler.getRewindPoints();

      expect(rewindPoints).toHaveLength(3);
      expect(rewindPoints[0].uuid).toBe('msg-3');
      expect(rewindPoints[0].turnNumber).toBe(3);
      expect(rewindPoints[2].uuid).toBe('msg-1');
      expect(rewindPoints[2].turnNumber).toBe(1);
    });
  });

  describe('getRewindPoint', () => {
    it('should get specific message by UUID', () => {
      handler = createHandler();
      const rewindPoint = handler.getRewindPoint(testRewindPoint.uuid);

      expect(getUserMessageByUuidSpy).toHaveBeenCalledWith(mockSession.id, testRewindPoint.uuid);
      expect(rewindPoint).toEqual(testRewindPoint);
    });

    it('should return undefined for non-existent UUID', () => {
      handler = createHandler();
      const rewindPoint = handler.getRewindPoint('non-existent');

      expect(rewindPoint).toBeUndefined();
    });
  });

  describe('previewRewind', () => {
    it('should return error when checkpoint not found', async () => {
      handler = createHandler();
      const result = await handler.previewRewind('nonexistent-id');

      expect(result.canRewind).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return error when SDK query not active', async () => {
      handler = createHandler({ queryObject: null });
      const result = await handler.previewRewind(testRewindPoint.uuid);

      expect(result.canRewind).toBe(false);
      expect(result.error).toContain('SDK query not active');
    });

    it('should return error when transport not ready', async () => {
      handler = createHandler({ firstMessageReceived: false });
      const result = await handler.previewRewind(testRewindPoint.uuid);

      expect(result.canRewind).toBe(false);
      expect(result.error).toContain('SDK not ready');
    });

    it('should call SDK rewindFiles with dryRun option', async () => {
      handler = createHandler();
      await handler.previewRewind(testRewindPoint.uuid);

      expect(rewindFilesSpy).toHaveBeenCalledWith(testRewindPoint.uuid, { dryRun: true });
    });

    it('should include messages affected count from DB', async () => {
      handler = createHandler();
      const result = await handler.previewRewind(testRewindPoint.uuid);

      expect(countMessagesAfterSpy).toHaveBeenCalledWith(mockSession.id, testTimestamp);
      expect(result.messagesAffected).toBe(5);
    });

    it('should return SDK result on success', async () => {
      handler = createHandler();
      const result = await handler.previewRewind(testRewindPoint.uuid);

      expect(result.canRewind).toBe(true);
      expect(result.filesChanged).toEqual(['file1.ts', 'file2.ts']);
      expect(result.insertions).toBe(10);
      expect(result.deletions).toBe(5);
      expect(result.messagesAffected).toBe(5);
    });

    it('should handle SDK errors gracefully', async () => {
      rewindFilesSpy.mockRejectedValue(new Error('SDK error'));
      handler = createHandler();
      const result = await handler.previewRewind(testRewindPoint.uuid);

      expect(result.canRewind).toBe(false);
      expect(result.error).toBe('SDK error');
      expect(mockLogger.error).toHaveBeenCalledWith('Rewind preview failed:', expect.any(Error));
    });

    it('should handle non-Error exceptions in preview', async () => {
      rewindFilesSpy.mockRejectedValue('String error');
      handler = createHandler();
      const result = await handler.previewRewind(testRewindPoint.uuid);

      expect(result.canRewind).toBe(false);
      expect(result.error).toBe('Unknown error');
    });
  });

  describe('executeRewind', () => {
    describe('files mode', () => {
      it('should emit rewind.started event', async () => {
        handler = createHandler();
        await handler.executeRewind(testRewindPoint.uuid, 'files');

        expect(emitSpy).toHaveBeenCalledWith('rewind.started', {
          sessionId: mockSession.id,
          checkpointId: testRewindPoint.uuid,
          mode: 'files',
        });
      });

      it('should call SDK rewindFiles without dryRun', async () => {
        handler = createHandler();
        await handler.executeRewind(testRewindPoint.uuid, 'files');

        expect(rewindFilesSpy).toHaveBeenCalledWith(testRewindPoint.uuid);
      });

      it('should emit rewind.completed on success', async () => {
        handler = createHandler();
        await handler.executeRewind(testRewindPoint.uuid, 'files');

        expect(emitSpy).toHaveBeenCalledWith('rewind.completed', {
          sessionId: mockSession.id,
          checkpointId: testRewindPoint.uuid,
          mode: 'files',
          result: {
            success: true,
            filesChanged: ['file1.ts', 'file2.ts'],
            insertions: 10,
            deletions: 5,
          },
        });
      });

      it('should emit rewind.failed when SDK returns canRewind false', async () => {
        rewindFilesSpy.mockResolvedValue({ canRewind: false, error: 'Cannot rewind' });
        handler = createHandler();
        const result = await handler.executeRewind(testRewindPoint.uuid, 'files');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Cannot rewind');
        expect(emitSpy).toHaveBeenCalledWith('rewind.failed', {
          sessionId: mockSession.id,
          checkpointId: testRewindPoint.uuid,
          mode: 'files',
          error: 'Cannot rewind',
        });
      });

      it('should return success with file changes', async () => {
        handler = createHandler();
        const result = await handler.executeRewind(testRewindPoint.uuid, 'files');

        expect(result.success).toBe(true);
        expect(result.filesChanged).toEqual(['file1.ts', 'file2.ts']);
      });
    });

    describe('conversation mode', () => {
      it('should delete messages from DB', async () => {
        handler = createHandler();
        await handler.executeRewind(testRewindPoint.uuid, 'conversation');

        expect(deleteMessagesAtAndAfterSpy).toHaveBeenCalledWith(mockSession.id, testTimestamp);
      });

      it('should set pending resumeSessionAt to previous user message after deletion', async () => {
        const previousMessage = {
          uuid: 'prev-msg-uuid',
          timestamp: testTimestamp - 10000,
          content: 'Previous message',
        };
        getUserMessagesSpy.mockReturnValue([previousMessage]);
        writeSdkTranscript([previousMessage.uuid]);

        handler = createHandler();
        await handler.executeRewind(testRewindPoint.uuid, 'conversation');

        expect(setPendingResumeSessionAtSpy).toHaveBeenCalledWith('prev-msg-uuid');
        expect(updateSessionSpy).not.toHaveBeenCalledWith(mockSession.id, {
          metadata: mockSession.metadata,
        });
      });

      it('should not set pending resumeSessionAt when previous user message is missing from SDK transcript', async () => {
        const previousMessage = {
          uuid: 'compacted-prev-msg-uuid',
          timestamp: testTimestamp - 10000,
          content: 'Previous message',
        };
        getUserMessagesSpy.mockReturnValue([previousMessage]);
        writeSdkTranscript(['different-message-uuid']);

        handler = createHandler();
        await handler.executeRewind(testRewindPoint.uuid, 'conversation');

        expect(setPendingResumeSessionAtSpy).not.toHaveBeenCalled();
        expect(clearPendingResumeSessionAtSpy).toHaveBeenCalled();
        expect(updateSessionSpy).not.toHaveBeenCalledWith(mockSession.id, {
          metadata: mockSession.metadata,
        });
      });

      it('should not set pending resumeSessionAt when no previous user message exists', async () => {
        getUserMessagesSpy.mockReturnValue([]);

        handler = createHandler();
        await handler.executeRewind(testRewindPoint.uuid, 'conversation');

        expect(setPendingResumeSessionAtSpy).not.toHaveBeenCalled();
        expect(clearPendingResumeSessionAtSpy).toHaveBeenCalled();
        expect(updateSessionSpy).not.toHaveBeenCalledWith(mockSession.id, {
          metadata: mockSession.metadata,
        });
      });

      it('should restart query', async () => {
        handler = createHandler();
        await handler.executeRewind(testRewindPoint.uuid, 'conversation');

        expect(restartSpy).toHaveBeenCalled();
      });

      it('should return success with conversation rewound', async () => {
        handler = createHandler();
        const result = await handler.executeRewind(testRewindPoint.uuid, 'conversation');

        expect(result.success).toBe(true);
        expect(result.conversationRewound).toBe(true);
        expect(result.messagesDeleted).toBe(5);
      });
    });

    describe('both mode', () => {
      it('should rewind files first', async () => {
        handler = createHandler();
        await handler.executeRewind(testRewindPoint.uuid, 'both');

        expect(rewindFilesSpy).toHaveBeenCalledWith(testRewindPoint.uuid);
      });

      it('should rewind conversation after files succeed', async () => {
        handler = createHandler();
        await handler.executeRewind(testRewindPoint.uuid, 'both');

        expect(deleteMessagesAtAndAfterSpy).toHaveBeenCalled();
        expect(restartSpy).toHaveBeenCalled();
      });

      it('should return combined result', async () => {
        handler = createHandler();
        const result = await handler.executeRewind(testRewindPoint.uuid, 'both');

        expect(result.success).toBe(true);
        expect(result.filesChanged).toEqual(['file1.ts', 'file2.ts']);
        expect(result.conversationRewound).toBe(true);
        expect(result.messagesDeleted).toBe(5);
      });

      it('should proceed with conversation rewind even if file rewind fails', async () => {
        rewindFilesSpy.mockResolvedValue({ canRewind: false, error: 'File rewind failed' });
        handler = createHandler();
        const result = await handler.executeRewind(testRewindPoint.uuid, 'both');

        expect(result.success).toBe(true);
        expect(result.conversationRewound).toBe(true);
        expect(deleteMessagesAtAndAfterSpy).toHaveBeenCalled();
        expect(result.filesChanged).toBeUndefined();
      });
    });

    describe('error handling', () => {
      it('should return error when checkpoint not found', async () => {
        handler = createHandler();
        const result = await handler.executeRewind('nonexistent-id', 'files');

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
      });

      it('should return error when SDK query not active', async () => {
        handler = createHandler({ queryObject: null });
        const result = await handler.executeRewind(testRewindPoint.uuid, 'files');

        expect(result.success).toBe(false);
        expect(result.error).toContain('SDK query not active');
      });

      it('should return error when firstMessageReceived is false', async () => {
        handler = createHandler({ firstMessageReceived: false });
        const result = await handler.executeRewind(testRewindPoint.uuid, 'files');

        expect(result.success).toBe(false);
        expect(result.error).toContain('SDK not ready');
      });

      it('should use default error message when SDK returns no error message for files mode', async () => {
        rewindFilesSpy.mockResolvedValue({ canRewind: false });
        handler = createHandler();
        const result = await handler.executeRewind(testRewindPoint.uuid, 'files');

        expect(result.success).toBe(false);
        expect(emitSpy).toHaveBeenCalledWith('rewind.failed', {
          sessionId: mockSession.id,
          checkpointId: testRewindPoint.uuid,
          mode: 'files',
          error: 'Rewind failed',
        });
      });

      it('should proceed with conversation rewind when file rewind returns no error for both mode', async () => {
        rewindFilesSpy.mockResolvedValue({ canRewind: false });
        handler = createHandler();
        const result = await handler.executeRewind(testRewindPoint.uuid, 'both');

        expect(result.success).toBe(true);
        expect(result.conversationRewound).toBe(true);
        expect(emitSpy).toHaveBeenCalledWith(
          'rewind.completed',
          expect.objectContaining({
            sessionId: mockSession.id,
            checkpointId: testRewindPoint.uuid,
            mode: 'both',
          })
        );
      });

      it('should handle exceptions and emit rewind.failed', async () => {
        rewindFilesSpy.mockRejectedValue(new Error('Unexpected error'));
        handler = createHandler();
        const result = await handler.executeRewind(testRewindPoint.uuid, 'files');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Unexpected error');
        expect(emitSpy).toHaveBeenCalledWith('rewind.failed', {
          sessionId: mockSession.id,
          checkpointId: testRewindPoint.uuid,
          mode: 'files',
          error: 'Unexpected error',
        });
      });

      it('should handle non-Error exceptions and emit rewind.failed', async () => {
        rewindFilesSpy.mockRejectedValue('String error');
        handler = createHandler();
        const result = await handler.executeRewind(testRewindPoint.uuid, 'files');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Unknown error');
        expect(emitSpy).toHaveBeenCalledWith('rewind.failed', {
          sessionId: mockSession.id,
          checkpointId: testRewindPoint.uuid,
          mode: 'files',
          error: 'Unknown error',
        });
      });
    });
  });

  describe('previewSelectiveRewind', () => {
    it('should return error when SDK query not active', async () => {
      handler = createHandler({ queryObject: null });
      const result = await handler.previewSelectiveRewind([testRewindPoint.uuid]);

      expect(result.canRewind).toBe(false);
      expect(result.error).toContain('SDK query not active');
    });

    it('should return error when firstMessageReceived is false', async () => {
      handler = createHandler({ firstMessageReceived: false });
      const result = await handler.previewSelectiveRewind([testRewindPoint.uuid]);

      expect(result.canRewind).toBe(false);
      expect(result.error).toContain('SDK not ready');
    });

    it('should return error when no valid messages found', async () => {
      mockDb.getSDKMessages = mock(() => ({
        messages: [{ uuid: 'different-uuid', timestamp: 1000 }],
        hasMore: false,
      }));
      handler = createHandler();
      const result = await handler.previewSelectiveRewind([testRewindPoint.uuid]);

      expect(result.canRewind).toBe(false);
      expect(result.error).toBe('No valid messages found');
    });

    it('should count messages to delete and preview file changes', async () => {
      mockDb.getSDKMessages = mock(() => ({
        messages: [
          { uuid: testRewindPoint.uuid, timestamp: testTimestamp },
          { uuid: 'msg-2', timestamp: testTimestamp + 1000 },
          { uuid: 'msg-3', timestamp: testTimestamp + 2000 },
        ],
        hasMore: false,
      }));

      handler = createHandler();
      const result = await handler.previewSelectiveRewind([testRewindPoint.uuid]);

      expect(result.canRewind).toBe(true);
      expect(result.messagesToDelete).toBe(2);
      expect(result.filesToRevert).toEqual([
        { path: 'file1.ts', hasCheckpoint: true, hasEditDiff: false },
        { path: 'file2.ts', hasCheckpoint: true, hasEditDiff: false },
      ]);
    });
  });

  describe('executeSelectiveRewind', () => {
    it('should return error when SDK query not active', async () => {
      handler = createHandler({ queryObject: null });
      const result = await handler.executeSelectiveRewind([testRewindPoint.uuid]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('SDK query not active');
    });

    it('should return error when firstMessageReceived is false', async () => {
      handler = createHandler({ firstMessageReceived: false });
      const result = await handler.executeSelectiveRewind([testRewindPoint.uuid]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('SDK not ready');
    });

    it('should rewind files, delete messages, and restart query', async () => {
      mockDb.getSDKMessages = mock(() => ({
        messages: [
          { uuid: testRewindPoint.uuid, timestamp: testTimestamp },
          { uuid: 'msg-2', timestamp: testTimestamp + 1000 },
        ],
        hasMore: false,
      }));

      handler = createHandler();
      const result = await handler.executeSelectiveRewind([testRewindPoint.uuid]);

      expect(rewindFilesSpy).toHaveBeenCalledWith(testRewindPoint.uuid);
      expect(deleteMessagesAtAndAfterSpy).toHaveBeenCalledWith(mockSession.id, testTimestamp);
      expect(restartSpy).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should set pending resumeSessionAt to previous user message after selective rewind', async () => {
      const previousMessage = {
        uuid: 'prev-msg-uuid',
        timestamp: testTimestamp - 10000,
        content: 'Previous message',
      };
      mockDb.getSDKMessages = mock(() => ({
        messages: [{ uuid: testRewindPoint.uuid, timestamp: testTimestamp }],
        hasMore: false,
      }));
      getUserMessagesSpy.mockReturnValue([previousMessage]);
      writeSdkTranscript([previousMessage.uuid]);

      handler = createHandler();
      await handler.executeSelectiveRewind([testRewindPoint.uuid]);

      expect(setPendingResumeSessionAtSpy).toHaveBeenCalledWith('prev-msg-uuid');
    });

    it('should not set pending resumeSessionAt after selective rewind when previous UUID is missing from SDK transcript', async () => {
      const previousMessage = {
        uuid: 'compacted-prev-msg-uuid',
        timestamp: testTimestamp - 10000,
        content: 'Previous message',
      };
      mockDb.getSDKMessages = mock(() => ({
        messages: [{ uuid: testRewindPoint.uuid, timestamp: testTimestamp }],
        hasMore: false,
      }));
      getUserMessagesSpy.mockReturnValue([previousMessage]);
      writeSdkTranscript(['different-message-uuid']);

      handler = createHandler();
      await handler.executeSelectiveRewind([testRewindPoint.uuid]);

      expect(setPendingResumeSessionAtSpy).not.toHaveBeenCalled();
      expect(clearPendingResumeSessionAtSpy).toHaveBeenCalled();
    });
  });

  describe('analyzeRewindCase', () => {
    it('should return sdk-native when earliest message is a user message', () => {
      handler = createHandler();

      const earliestMessage = {
        uuid: 'user-msg-1',
        type: 'user',
        timestamp: 1000,
        content: 'User message',
      };

      const messagesInRange = [earliestMessage];
      const userMessagesInRange = [{ uuid: 'user-msg-1', timestamp: 1000 }];

      const analysis = handler.analyzeRewindCase(
        earliestMessage,
        messagesInRange,
        userMessagesInRange
      );

      expect(analysis.rewindCase).toBe('sdk-native');
      expect(analysis.messagesBeforeUser).toEqual([]);
    });

    it('should return diff-based when no user messages in range', () => {
      handler = createHandler();

      const earliestMessage = {
        uuid: 'assistant-msg-1',
        type: 'assistant',
        timestamp: 1000,
      };

      const messagesInRange = [
        earliestMessage,
        { uuid: 'assistant-msg-2', type: 'assistant', timestamp: 2000 },
      ];
      const userMessagesInRange: Array<{ uuid: string; timestamp: number }> = [];

      const analysis = handler.analyzeRewindCase(
        earliestMessage,
        messagesInRange,
        userMessagesInRange
      );

      expect(analysis.rewindCase).toBe('diff-based');
      expect(analysis.messagesBeforeUser).toHaveLength(2);
    });

    it('should return hybrid when earliest is not user but user messages exist after', () => {
      handler = createHandler();

      const earliestMessage = {
        uuid: 'assistant-msg-1',
        type: 'assistant',
        timestamp: 1000,
      };

      const messagesInRange = [
        earliestMessage,
        { uuid: 'assistant-msg-2', type: 'assistant', timestamp: 2000 },
        { uuid: 'user-msg-1', type: 'user', timestamp: 3000 },
        { uuid: 'assistant-msg-3', type: 'assistant', timestamp: 4000 },
      ];
      const userMessagesInRange = [{ uuid: 'user-msg-1', timestamp: 3000 }];

      const analysis = handler.analyzeRewindCase(
        earliestMessage,
        messagesInRange,
        userMessagesInRange
      );

      expect(analysis.rewindCase).toBe('hybrid');
      expect(analysis.oldestUserMessage).toEqual({ uuid: 'user-msg-1', timestamp: 3000 });
      expect(analysis.messagesBeforeUser).toHaveLength(2);
      expect(analysis.messagesBeforeUser[0].uuid).toBe('assistant-msg-1');
      expect(analysis.messagesBeforeUser[1].uuid).toBe('assistant-msg-2');
    });
  });

  describe('extractFileOperations', () => {
    it('should extract Edit tool blocks from assistant messages', () => {
      handler = createHandler();

      const messages = [
        {
          uuid: 'assistant-msg-1',
          type: 'assistant',
          timestamp: 1000,
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Edit',
              input: {
                file_path: '/tmp/test.ts',
                old_string: 'old code',
                new_string: 'new code',
              },
            },
          ],
        },
      ];

      const operations = handler.extractFileOperations(messages);

      expect(operations).toHaveLength(1);
      expect(operations[0].type).toBe('edit');
      expect(operations[0].filePath).toBe('/tmp/test.ts');
      expect(operations[0].oldString).toBe('old code');
      expect(operations[0].newString).toBe('new code');
    });

    it('should extract Write tool blocks from assistant messages', () => {
      handler = createHandler();

      const messages = [
        {
          uuid: 'assistant-msg-1',
          type: 'assistant',
          timestamp: 1000,
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Write',
              input: {
                file_path: '/tmp/new-file.ts',
                content: 'file content',
              },
            },
          ],
        },
      ];

      const operations = handler.extractFileOperations(messages);

      expect(operations).toHaveLength(1);
      expect(operations[0].type).toBe('write');
      expect(operations[0].filePath).toBe('/tmp/new-file.ts');
      expect(operations[0].content).toBe('file content');
    });

    it('should skip non-file tool blocks (Read, Bash, Grep)', () => {
      handler = createHandler();

      const messages = [
        {
          uuid: 'assistant-msg-1',
          type: 'assistant',
          timestamp: 1000,
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Read',
              input: { file_path: '/tmp/test.ts' },
            },
            {
              type: 'tool_use',
              id: 'tool-2',
              name: 'Bash',
              input: { command: 'ls -la' },
            },
            {
              type: 'tool_use',
              id: 'tool-3',
              name: 'Grep',
              input: { pattern: 'search' },
            },
          ],
        },
      ];

      const operations = handler.extractFileOperations(messages);

      expect(operations).toEqual([]);
    });

    it('should return empty when no assistant messages', () => {
      handler = createHandler();

      const messages = [
        {
          uuid: 'user-msg-1',
          type: 'user',
          timestamp: 1000,
          content: 'User message',
        },
      ];

      const operations = handler.extractFileOperations(messages);

      expect(operations).toEqual([]);
    });

    it('should handle multiple operations across multiple messages', () => {
      handler = createHandler();

      const messages = [
        {
          uuid: 'assistant-msg-1',
          type: 'assistant',
          timestamp: 1000,
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Edit',
              input: {
                file_path: '/tmp/file1.ts',
                old_string: 'old1',
                new_string: 'new1',
              },
            },
            {
              type: 'tool_use',
              id: 'tool-2',
              name: 'Write',
              input: {
                file_path: '/tmp/file2.ts',
                content: 'content2',
              },
            },
          ],
        },
        {
          uuid: 'assistant-msg-2',
          type: 'assistant',
          timestamp: 2000,
          content: [
            {
              type: 'tool_use',
              id: 'tool-3',
              name: 'Edit',
              input: {
                file_path: '/tmp/file3.ts',
                old_string: 'old3',
                new_string: 'new3',
              },
            },
          ],
        },
      ];

      const operations = handler.extractFileOperations(messages);

      expect(operations).toHaveLength(3);
      expect(operations[0].filePath).toBe('/tmp/file1.ts');
      expect(operations[1].filePath).toBe('/tmp/file2.ts');
      expect(operations[2].filePath).toBe('/tmp/file3.ts');
    });
  });

  describe('revertFileOperations', () => {
    const { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } = require('node:fs');
    const { join } = require('node:path');
    const { tmpdir } = require('node:os');

    let testDir: string;

    beforeEach(() => {
      testDir = join(tmpdir(), `rewind-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should reverse an Edit operation (swap old/new in file)', async () => {
      handler = createHandler();

      const filePath = join(testDir, 'test.ts');
      writeFileSync(filePath, 'function test() {\n  new code\n}\n', 'utf-8');

      const operations = [
        {
          type: 'edit' as const,
          filePath,
          oldString: 'old code',
          newString: 'new code',
        },
      ];

      const result = await handler.revertFileOperations(operations);

      expect(result.reverted).toEqual([filePath]);
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual([]);

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('old code');
      expect(content).not.toContain('new code');
    });

    it('should skip Write operations with warning', async () => {
      handler = createHandler();

      const filePath = join(testDir, 'new-file.ts');

      const operations = [
        {
          type: 'write' as const,
          filePath,
          content: 'file content',
        },
      ];

      const result = await handler.revertFileOperations(operations);

      expect(result.reverted).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual([filePath]);
    });

    it('should process operations in reverse order', async () => {
      handler = createHandler();

      const filePath = join(testDir, 'test.ts');
      writeFileSync(filePath, 'content C\n', 'utf-8');

      const operations = [
        {
          type: 'edit' as const,
          filePath,
          oldString: 'content A',
          newString: 'content B',
        },
        {
          type: 'edit' as const,
          filePath,
          oldString: 'content B',
          newString: 'content C',
        },
      ];

      const result = await handler.revertFileOperations(operations);

      expect(result.reverted).toEqual([filePath]);

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toBe('content A\n');
    });

    it('should add to failed when file not found', async () => {
      handler = createHandler();

      const filePath = join(testDir, 'nonexistent.ts');

      const operations = [
        {
          type: 'edit' as const,
          filePath,
          oldString: 'old',
          newString: 'new',
        },
      ];

      const result = await handler.revertFileOperations(operations);

      expect(result.reverted).toEqual([]);
      expect(result.failed).toEqual([filePath]);
      expect(result.skipped).toEqual([]);
    });

    it('should add to failed when new_string not found in file', async () => {
      handler = createHandler();

      const filePath = join(testDir, 'test.ts');
      writeFileSync(filePath, 'content that does not match\n', 'utf-8');

      const operations = [
        {
          type: 'edit' as const,
          filePath,
          oldString: 'old',
          newString: 'new',
        },
      ];

      const result = await handler.revertFileOperations(operations);

      expect(result.reverted).toEqual([]);
      expect(result.failed).toEqual([filePath]);
      expect(result.skipped).toEqual([]);
    });
  });

  describe('executeSelectiveRewind - 3 cases', () => {
    describe('Case 1: sdk-native', () => {
      it('mode=files uses SDK rewindFiles for user message selection', async () => {
        const userMessageUuid = 'user-msg-1';
        const userTimestamp = 1000;

        mockDb.getSDKMessages = mock(() => ({
          messages: [
            { uuid: userMessageUuid, type: 'user', timestamp: userTimestamp },
            { uuid: 'msg-2', type: 'assistant', timestamp: userTimestamp + 1000 },
          ],
          hasMore: false,
        }));
        getUserMessagesSpy.mockReturnValue([
          { uuid: userMessageUuid, timestamp: userTimestamp, content: 'User message' },
        ]);

        handler = createHandler();
        const result = await handler.executeSelectiveRewind([userMessageUuid], 'files');

        expect(rewindFilesSpy).toHaveBeenCalledWith(userMessageUuid);
        expect(deleteMessagesAtAndAfterSpy).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(result.rewindCase).toBe('sdk-native');
      });

      it('mode=conversation deletes DB + truncates JSONL', async () => {
        const userMessageUuid = 'user-msg-1';
        const userTimestamp = 1000;

        mockDb.getSDKMessages = mock(() => ({
          messages: [
            { uuid: userMessageUuid, type: 'user', timestamp: userTimestamp },
            { uuid: 'msg-2', type: 'assistant', timestamp: userTimestamp + 1000 },
          ],
          hasMore: false,
        }));
        getUserMessagesSpy.mockReturnValue([
          { uuid: userMessageUuid, timestamp: userTimestamp, content: 'User message' },
        ]);

        handler = createHandler();
        const result = await handler.executeSelectiveRewind([userMessageUuid], 'conversation');

        expect(rewindFilesSpy).not.toHaveBeenCalled();
        expect(deleteMessagesAtAndAfterSpy).toHaveBeenCalledWith(mockSession.id, userTimestamp);
        expect(restartSpy).toHaveBeenCalled();
        expect(result.success).toBe(true);
      });

      it('mode=both does files and conversation', async () => {
        const userMessageUuid = 'user-msg-1';
        const userTimestamp = 1000;

        mockDb.getSDKMessages = mock(() => ({
          messages: [
            { uuid: userMessageUuid, type: 'user', timestamp: userTimestamp },
            { uuid: 'msg-2', type: 'assistant', timestamp: userTimestamp + 1000 },
          ],
          hasMore: false,
        }));
        getUserMessagesSpy.mockReturnValue([
          { uuid: userMessageUuid, timestamp: userTimestamp, content: 'User message' },
        ]);

        handler = createHandler();
        const result = await handler.executeSelectiveRewind([userMessageUuid], 'both');

        expect(rewindFilesSpy).toHaveBeenCalledWith(userMessageUuid);
        expect(deleteMessagesAtAndAfterSpy).toHaveBeenCalledWith(mockSession.id, userTimestamp);
        expect(restartSpy).toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(result.rewindCase).toBe('sdk-native');
      });
    });

    describe('Case 2: diff-based', () => {
      it('mode=both with no user messages uses diff-based file revert + conversation rewind', async () => {
        const assistantMessageUuid = 'assistant-msg-1';
        const assistantTimestamp = 1000;

        mockDb.getSDKMessages = mock(() => ({
          messages: [
            {
              uuid: assistantMessageUuid,
              type: 'assistant',
              timestamp: assistantTimestamp,
              content: [
                {
                  type: 'tool_use',
                  id: 'tool-1',
                  name: 'Edit',
                  input: {
                    file_path: '/tmp/test.ts',
                    old_string: 'old',
                    new_string: 'new',
                  },
                },
              ],
            },
            { uuid: 'assistant-msg-2', type: 'assistant', timestamp: assistantTimestamp + 1000 },
          ],
          hasMore: false,
        }));
        getUserMessagesSpy.mockReturnValue([]);

        handler = createHandler();
        const result = await handler.executeSelectiveRewind([assistantMessageUuid], 'both');

        expect(rewindFilesSpy).not.toHaveBeenCalled();
        expect(deleteMessagesAtAndAfterSpy).toHaveBeenCalledWith(
          mockSession.id,
          assistantTimestamp
        );
        expect(restartSpy).toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(result.rewindCase).toBe('diff-based');
      });
    });

    describe('Case 3: hybrid', () => {
      it('mode=both with assistant before user message uses hybrid approach', async () => {
        const assistantMessageUuid = 'assistant-msg-1';
        const userMessageUuid = 'user-msg-1';

        mockDb.getSDKMessages = mock(() => ({
          messages: [
            { uuid: assistantMessageUuid, type: 'assistant', timestamp: 1000 },
            { uuid: userMessageUuid, type: 'user', timestamp: 2000 },
            { uuid: 'assistant-msg-2', type: 'assistant', timestamp: 3000 },
          ],
          hasMore: false,
        }));
        getUserMessagesSpy.mockReturnValue([
          { uuid: userMessageUuid, timestamp: 2000, content: 'User message' },
        ]);

        handler = createHandler();
        const result = await handler.executeSelectiveRewind([assistantMessageUuid], 'both');

        expect(rewindFilesSpy).toHaveBeenCalledWith(userMessageUuid);
        expect(deleteMessagesAtAndAfterSpy).toHaveBeenCalledWith(mockSession.id, 1000);
        expect(restartSpy).toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(result.rewindCase).toBe('hybrid');
      });
    });
  });
});

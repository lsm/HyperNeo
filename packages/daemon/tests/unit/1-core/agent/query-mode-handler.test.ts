/**
 * QueryModeHandler Tests
 *
 * Tests for query mode operations (Manual/Auto-queue).
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import {
  QueryModeHandler,
  type QueryModeHandlerContext,
} from '../../../../src/lib/agent/query-mode-handler';
import type { Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Database } from '../../../../src/storage/database';
import { Database as DatabaseImpl } from '../../../../src/storage/sqlite-compat';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { Logger } from '../../../../src/lib/logger';

describe('QueryModeHandler', () => {
  let handler: QueryModeHandler;
  let mockSession: Session;
  let mockDb: Database;
  let mockDaemonHub: DaemonHub;
  let mockInternalEventBus: InternalEventBus<any>;
  let mockMessageQueue: MessageQueue;
  let mockLogger: Logger;

  let getMessagesByStatusSpy: ReturnType<typeof mock>;
  let updateMessageStatusSpy: ReturnType<typeof mock>;
  let emitSpy: ReturnType<typeof mock>;
  let enqueueWithIdSpy: ReturnType<typeof mock>;
  let ensureQueryStartedSpy: ReturnType<typeof mock>;
  let v2Previous: string | undefined;

  beforeEach(() => {
    // The legacy inline replay path is preserved as the HYPERNEO_MESSAGE_DELIVERY_V2=0
    // opt-out. These existing assertions cover THAT branch; the v2-default durable
    // path has its own describe block below.
    v2Previous = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
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
    updateMessageStatusSpy = mock(() => {});
    mockDb = {
      getMessagesByStatus: getMessagesByStatusSpy,
      updateMessageStatus: updateMessageStatusSpy,
      // message-delivery v2 legacy-replay guard: no active v2 jobs in these
      // tests, so the replay paths are unfiltered.
      getJobQueueRepo: () => ({ activeDeliveryMessageUuids: () => new Set<string>() }),
    } as unknown as Database;

    emitSpy = mock(async () => {});
    mockInternalEventBus = {
      publish: emitSpy,
      publishAsync: emitSpy,
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;
    mockDaemonHub = {
      emit: emitSpy,
    } as unknown as DaemonHub;

    enqueueWithIdSpy = mock(async () => {});
    mockMessageQueue = {
      enqueueWithId: enqueueWithIdSpy,
    } as unknown as MessageQueue;

    mockLogger = {
      log: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
      info: mock(() => {}),
    } as unknown as Logger;

    ensureQueryStartedSpy = mock(async () => {});
  });

  afterEach(() => {
    if (v2Previous === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = v2Previous;
  });

  function createContext(): QueryModeHandlerContext {
    return {
      session: mockSession,
      db: mockDb,
      daemonHub: mockDaemonHub,
      internalEventBus: mockInternalEventBus,
      messageQueue: mockMessageQueue,
      logger: mockLogger,
      ensureQueryStarted: ensureQueryStartedSpy,
    };
  }

  function createHandler(): QueryModeHandler {
    return new QueryModeHandler(createContext());
  }

  describe('constructor', () => {
    it('should create handler with dependencies', () => {
      handler = createHandler();
      expect(handler).toBeDefined();
    });
  });

  describe('handleQueryTrigger', () => {
    it('should return success with 0 messages if no deferred messages', async () => {
      getMessagesByStatusSpy.mockReturnValue([]);
      handler = createHandler();

      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 0 });
    });

    it('should update message status to enqueued', async () => {
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user', content: 'Hello' },
        } as unknown as SDKMessage,
      ];
      getMessagesByStatusSpy.mockReturnValue(savedMessages);
      handler = createHandler();

      await handler.handleQueryTrigger();

      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1'], 'enqueued');
    });

    it('should emit messages.statusChanged event', async () => {
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user', content: 'Hello' },
        } as unknown as SDKMessage,
      ];
      getMessagesByStatusSpy.mockReturnValue(savedMessages);
      handler = createHandler();

      await handler.handleQueryTrigger();

      expect(emitSpy).toHaveBeenCalledWith('messages.statusChanged', {
        sessionId: 'test-session-id',
        messageIds: ['db-1'],
        status: 'enqueued',
      });
    });

    it('should call ensureQueryStarted', async () => {
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user', content: 'Hello' },
        } as unknown as SDKMessage,
      ];
      getMessagesByStatusSpy.mockReturnValue(savedMessages);
      handler = createHandler();

      await handler.handleQueryTrigger();

      expect(ensureQueryStartedSpy).toHaveBeenCalled();
    });

    it('should enqueue messages with string content', async () => {
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user', content: 'Hello world' },
        } as unknown as SDKMessage,
      ];
      getMessagesByStatusSpy.mockReturnValue(savedMessages);
      handler = createHandler();

      await handler.handleQueryTrigger();

      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-1', 'Hello world');
    });

    it('should enqueue messages with array content', async () => {
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'Line 1' },
              { type: 'text', text: 'Line 2' },
            ],
          },
        } as unknown as SDKMessage,
      ];
      getMessagesByStatusSpy.mockReturnValue(savedMessages);
      handler = createHandler();

      await handler.handleQueryTrigger();

      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-1', 'Line 1\nLine 2');
    });

    it('should preserve image blocks when enqueueing deferred multimodal messages', async () => {
      const content = [
        {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'abc' },
        },
        { type: 'text' as const, text: 'Describe this' },
      ];
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user', content },
        } as unknown as SDKMessage,
      ];
      getMessagesByStatusSpy.mockReturnValue(savedMessages);
      handler = createHandler();

      await handler.handleQueryTrigger();

      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-1', content);
    });

    it('should skip non-user messages', async () => {
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'assistant',
          message: { role: 'assistant', content: [] },
        } as unknown as SDKMessage,
      ];
      getMessagesByStatusSpy.mockReturnValue(savedMessages);
      handler = createHandler();

      await handler.handleQueryTrigger();

      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
    });

    it('should skip messages without content', async () => {
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user' }, // No content
        } as unknown as SDKMessage,
      ];
      getMessagesByStatusSpy.mockReturnValue(savedMessages);
      handler = createHandler();

      await handler.handleQueryTrigger();

      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
    });

    it('should return error on failure', async () => {
      getMessagesByStatusSpy.mockImplementation(() => {
        throw new Error('Database error');
      });
      handler = createHandler();

      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({
        success: false,
        messageCount: 0,
        error: 'Database error',
      });
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to trigger query:', expect.any(Error));
    });

    it('should return message count on success', async () => {
      const savedMessages: SDKMessage[] = [
        { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'Hello' } },
        { dbId: 'db-2', uuid: 'uuid-2', type: 'user', message: { role: 'user', content: 'World' } },
      ] as unknown as SDKMessage[];
      getMessagesByStatusSpy.mockReturnValue(savedMessages);
      handler = createHandler();

      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 2 });
    });
  });

  describe('sendEnqueuedMessagesOnTurnEnd', () => {
    it('should return early if no enqueued messages', async () => {
      getMessagesByStatusSpy.mockReturnValue([]);
      handler = createHandler();

      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(ensureQueryStartedSpy).not.toHaveBeenCalled();
    });

    it('should enqueue enqueued messages', async () => {
      const queuedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user', content: 'Queued message' },
        } as unknown as SDKMessage,
      ];
      getMessagesByStatusSpy.mockReturnValue(queuedMessages);
      handler = createHandler();

      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(ensureQueryStartedSpy).toHaveBeenCalled();
      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-1', 'Queued message');
    });

    it('should skip non-user messages', async () => {
      const queuedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'system',
          subtype: 'init',
        } as unknown as SDKMessage,
      ];
      getMessagesByStatusSpy.mockReturnValue(queuedMessages);
      handler = createHandler();

      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      getMessagesByStatusSpy.mockImplementation(() => {
        throw new Error('Database error');
      });
      handler = createHandler();

      // Should not throw
      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to send enqueued messages on turn end:',
        expect.any(Error)
      );
    });

    it('should process multiple enqueued messages', async () => {
      const queuedMessages: SDKMessage[] = [
        { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'First' } },
        {
          dbId: 'db-2',
          uuid: 'uuid-2',
          type: 'user',
          message: { role: 'user', content: 'Second' },
        },
      ] as unknown as SDKMessage[];
      getMessagesByStatusSpy.mockReturnValue(queuedMessages);
      handler = createHandler();

      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(enqueueWithIdSpy).toHaveBeenCalledTimes(2);
      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-1', 'First');
      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-2', 'Second');
    });

    it('should preserve image blocks when replaying enqueued messages', async () => {
      const content = [
        {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'abc' },
        },
        { type: 'text' as const, text: 'Describe this' },
      ];
      const queuedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user', content },
        } as unknown as SDKMessage,
      ];
      getMessagesByStatusSpy.mockReturnValue(queuedMessages);
      handler = createHandler();

      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-1', content);
    });
  });

  describe('replayPendingMessagesForImmediateMode', () => {
    it('should replay enqueued messages before deferred messages', async () => {
      const queuedMessages: SDKMessage[] = [
        {
          dbId: 'db-enqueued-1',
          uuid: 'uuid-enqueued-1',
          type: 'user',
          message: { role: 'user', content: 'Current turn (enqueued)' },
        } as unknown as SDKMessage,
      ];
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-deferred-1',
          uuid: 'uuid-deferred-1',
          type: 'user',
          message: { role: 'user', content: 'Next turn (deferred)' },
        } as unknown as SDKMessage,
      ];
      getMessagesByStatusSpy.mockImplementation((_: string, status: string) =>
        status === 'enqueued' ? queuedMessages : savedMessages
      );
      handler = createHandler();

      await handler.replayPendingMessagesForImmediateMode();

      expect(enqueueWithIdSpy).toHaveBeenCalledTimes(2);
      expect(enqueueWithIdSpy.mock.calls[0]).toEqual([
        'uuid-enqueued-1',
        'Current turn (enqueued)',
      ]);
      expect(enqueueWithIdSpy.mock.calls[1]).toEqual(['uuid-deferred-1', 'Next turn (deferred)']);
    });
  });

  // Durable delivery (v2 default): the legacy kickoff paths route through the
  // `deliverMessage` chokepoint instead of the inline ensureQueryStarted +
  // enqueueWithId. The handler then owns driving the turn / feeding steers.
  describe('durable delivery (v2 default) — task #861 item 3', () => {
    let jobQueue: JobQueueRepository;
    let jobsDb: Database;

    beforeEach(() => {
      // v2 default-on for this block.
      process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '1';
      // A real in-memory job_queue so deliverMessage's enqueue + role arbitration
      // (uq_message_delivery_active_turn) execute against the real index.
      jobsDb = new DatabaseImpl(':memory:');
      jobsDb.exec(`
        CREATE TABLE job_queue (
          id TEXT PRIMARY KEY,
          queue TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          payload TEXT NOT NULL DEFAULT '{}',
          result TEXT, error TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 3,
          retry_count INTEGER NOT NULL DEFAULT 0,
          run_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          started_at INTEGER, completed_at INTEGER
        );
        CREATE UNIQUE INDEX uq_message_delivery_active_turn
          ON job_queue (queue, json_extract(payload, '$.sessionId'))
          WHERE queue = 'message_delivery'
            AND json_extract(payload, '$.role') = 'turn'
            AND status IN ('pending', 'processing');
      `);
      jobQueue = new JobQueueRepository(jobsDb as never);
      mockDb = {
        getMessagesByStatus: getMessagesByStatusSpy,
        updateMessageStatus: updateMessageStatusSpy,
        getJobQueueRepo: () => jobQueue,
      } as unknown as Database;
    });

    afterEach(() => {
      jobsDb.close();
    });

    function deliveryUuids(): Array<{ uuid: string; role: string }> {
      return jobsDb
        .prepare(
          `SELECT json_extract(payload, '$.messageUuid') AS uuid,
                  json_extract(payload, '$.role') AS role
             FROM job_queue WHERE queue = 'message_delivery'
            ORDER BY created_at ASC`
        )
        .all() as Array<{ uuid: string; role: string }>;
    }

    it('handleQueryTrigger coalesces multiple deferred messages into ONE batched turn job', async () => {
      getMessagesByStatusSpy.mockReturnValue([
        { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'one' } },
        { dbId: 'db-2', uuid: 'uuid-2', type: 'user', message: { role: 'user', content: 'two' } },
        { dbId: 'db-3', uuid: 'uuid-3', type: 'user', message: { role: 'user', content: 'three' } },
      ] as unknown as SDKMessage[]);

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      // Status flip to enqueued still fires (so the handler drives, not skips).
      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1', 'db-2', 'db-3'], 'enqueued');
      // ONE batched turn job carries every UUID (kickoff = first); no steers.
      const jobs = deliveryUuids();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].uuid).toBe('uuid-1');
      expect(jobs[0].role).toBe('turn');
      const row = jobsDb
        .prepare(`SELECT payload FROM job_queue WHERE queue = 'message_delivery'`)
        .get() as { payload: string };
      expect(JSON.parse(row.payload).batchUuids).toEqual(['uuid-1', 'uuid-2', 'uuid-3']);
      // The inline transport path is NOT used under v2.
      expect(ensureQueryStartedSpy).not.toHaveBeenCalled();
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
    });

    it('handleQueryTrigger falls back to per-message jobs when a turn is already active', async () => {
      // Pre-insert an active turn for another session message — the batch
      // enqueue hits the uq_message_delivery_active_turn index and falls back
      // to the pre-batch first-turn/rest-steer behavior (here: all steers).
      jobQueue.enqueue({
        queue: 'message_delivery',
        payload: {
          sessionId: 'test-session-id',
          messageUuid: 'uuid-active',
          role: 'turn',
          origin: 'chat',
          parentToolUseId: null,
        },
      });
      getMessagesByStatusSpy.mockReturnValue([
        { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'one' } },
        { dbId: 'db-2', uuid: 'uuid-2', type: 'user', message: { role: 'user', content: 'two' } },
      ] as unknown as SDKMessage[]);

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 2 });
      const jobs = deliveryUuids();
      expect(jobs.map((j) => j.uuid).sort()).toEqual(['uuid-1', 'uuid-2', 'uuid-active']);
      // The pre-existing turn stays; both flush messages steer into it, with
      // no batchUuids on any job (no coalescing happened).
      expect(jobs.filter((j) => j.role === 'steer')).toHaveLength(2);
      const payloads = jobsDb
        .prepare(`SELECT payload FROM job_queue WHERE queue = 'message_delivery'`)
        .all() as Array<{ payload: string }>;
      expect(payloads.every((p) => !('batchUuids' in JSON.parse(p.payload)))).toBe(true);
    });

    it('handleQueryTrigger does NOT batch a mixed flush (image between texts preserves queue order)', async () => {
      getMessagesByStatusSpy.mockReturnValue([
        { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'one' } },
        {
          dbId: 'db-2',
          uuid: 'uuid-2',
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'image', source: { type: 'base64' } }],
          },
        },
        { dbId: 'db-3', uuid: 'uuid-3', type: 'user', message: { role: 'user', content: 'three' } },
      ] as unknown as SDKMessage[]);

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      // Batching only the texts would deliver text C before the earlier image
      // B — the whole flush falls back to per-message (first turn, rest steer)
      // so queue order is preserved.
      const jobs = deliveryUuids();
      expect(jobs).toHaveLength(3);
      expect(jobs.find((j) => j.uuid === 'uuid-1')?.role).toBe('turn');
      expect(jobs.find((j) => j.uuid === 'uuid-2')?.role).toBe('steer');
      expect(jobs.find((j) => j.uuid === 'uuid-3')?.role).toBe('steer');
      const payloads = jobsDb
        .prepare(`SELECT payload FROM job_queue WHERE queue = 'message_delivery'`)
        .all() as Array<{ payload: string }>;
      expect(payloads.every((p) => !('batchUuids' in JSON.parse(p.payload)))).toBe(true);
    });

    it('handleQueryTrigger does NOT batch a flush containing an SDK slash command', async () => {
      getMessagesByStatusSpy.mockReturnValue([
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user', content: '/compact' },
        },
        { dbId: 'db-2', uuid: 'uuid-2', type: 'user', message: { role: 'user', content: 'note' } },
      ] as unknown as SDKMessage[]);

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 2 });
      // A batch delimiter prefix would turn the command into literal prompt
      // text — per-message delivery keeps it standalone.
      const jobs = deliveryUuids();
      expect(jobs).toHaveLength(2);
      expect(jobs.find((j) => j.uuid === 'uuid-1')?.role).toBe('turn');
      expect(jobs.find((j) => j.uuid === 'uuid-2')?.role).toBe('steer');
    });

    it('handleQueryTrigger skips batch-owned members in the per-message fallback (replay race)', async () => {
      // Startup/replay flush while the batched turn is still pending: the
      // batch attempt declines (members are active), and the fallback must
      // NOT give the members individual steer jobs on top of the pending
      // combined prompt — that would execute each prompt twice.
      jobQueue.enqueue({
        queue: 'message_delivery',
        payload: {
          sessionId: 'test-session-id',
          messageUuid: 'uuid-1',
          role: 'turn',
          origin: 'recovery',
          parentToolUseId: null,
          batchUuids: ['uuid-1', 'uuid-2', 'uuid-3'],
        },
      });
      getMessagesByStatusSpy.mockReturnValue([
        { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'one' } },
        { dbId: 'db-2', uuid: 'uuid-2', type: 'user', message: { role: 'user', content: 'two' } },
        { dbId: 'db-3', uuid: 'uuid-3', type: 'user', message: { role: 'user', content: 'three' } },
      ] as unknown as SDKMessage[]);

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      // Only the pre-existing batch job remains — no per-member jobs added.
      const jobs = deliveryUuids();
      expect(jobs.map((j) => j.uuid)).toEqual(['uuid-1']);
      expect(jobs[0].role).toBe('turn');
    });

    it('sendEnqueuedMessagesOnTurnEnd enqueues a durable job per enqueued message', async () => {
      getMessagesByStatusSpy.mockReturnValue([
        { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'q' } },
      ] as unknown as SDKMessage[]);

      handler = new QueryModeHandler(createContext());
      await handler.sendEnqueuedMessagesOnTurnEnd();

      const jobs = deliveryUuids();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].uuid).toBe('uuid-1');
      expect(jobs[0].role).toBe('turn');
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
    });
  });
});

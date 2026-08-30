import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { ClearConversationCancelledError } from '../../../../src/lib/agent/agent-session';
import {
  admitAcrossContextClearBoundary,
  clearContextClearBoundariesForTest,
  withContextClearBoundary,
} from '../../../../src/lib/agent/message-delivery';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import {
  QueryModeHandler,
  type QueryModeHandlerContext,
} from '../../../../src/lib/agent/query-mode-handler';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Logger } from '../../../../src/lib/logger';
import type { Database } from '../../../../src/storage/database';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { Database as DatabaseImpl } from '../../../../src/storage/sqlite-compat';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';

function byStatusResult(messages: SDKMessage[]): { messages: SDKMessage[]; total: number } {
  return { messages, total: messages.length };
}

describe('QueryModeHandler', () => {
  let handler: QueryModeHandler;
  let mockSession: Session;
  let mockDb: Database;
  let mockDaemonHub: DaemonHub;
  let mockInternalEventBus: InternalEventBus<any>;
  let mockMessageQueue: MessageQueue;
  let mockLogger: Logger;

  let getUserMessagesByStatusSpy: ReturnType<typeof mock>;
  let updateMessageStatusSpy: ReturnType<typeof mock>;
  let emitSpy: ReturnType<typeof mock>;
  let enqueueWithIdSpy: ReturnType<typeof mock>;
  let sizeSpy: ReturnType<typeof mock>;
  let hasPendingOrInFlightSpy: ReturnType<typeof mock>;
  let ensureQueryStartedSpy: ReturnType<typeof mock>;

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

    getUserMessagesByStatusSpy = mock(() => ({ messages: [], total: 0 }));
    updateMessageStatusSpy = mock(() => {});
    mockDb = {
      getUserMessagesByStatus: getUserMessagesByStatusSpy,
      updateMessageStatus: updateMessageStatusSpy,
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
    sizeSpy = mock(() => 0);
    hasPendingOrInFlightSpy = mock(() => false);
    mockMessageQueue = {
      enqueueWithId: enqueueWithIdSpy,
      hasPendingOrInFlight: hasPendingOrInFlightSpy,
      size: sizeSpy,
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

  describe('clear_then_flush boundary hold (v2)', () => {
    let jobQueue: JobQueueRepository;
    let jobsDb: Database;

    beforeEach(() => {
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
          started_at INTEGER,
          heartbeat_at INTEGER, completed_at INTEGER
        );
        CREATE UNIQUE INDEX uq_message_delivery_active_turn
          ON job_queue (queue, json_extract(payload, '$.sessionId'))
          WHERE queue = 'message_delivery'
            AND json_extract(payload, '$.role') = 'turn'
            AND status IN ('pending', 'processing');
      `);
      jobQueue = new JobQueueRepository(jobsDb as never);
      mockDb = {
        getUserMessagesByStatus: getUserMessagesByStatusSpy,
        updateMessageStatus: updateMessageStatusSpy,
        getJobQueueRepo: () => jobQueue,
      } as unknown as Database;
    });

    afterEach(() => {
      jobsDb.close();
      clearContextClearBoundariesForTest();
    });

    it('defers the flush instead of clearing unprotected when the boundary stays busy', async () => {
      const previousTimeout = process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
      process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = '50';
      try {
        getUserMessagesByStatusSpy.mockImplementation((_: string, status: string) =>
          byStatusResult(
            status === 'deferred'
              ? [
                  {
                    dbId: 'db-task',
                    uuid: 'uuid-task',
                    type: 'user',
                    isSynthetic: true,
                    inputKind: 'task',
                    message: { role: 'user', content: 'the older task row' },
                  },
                  {
                    dbId: 'db-human',
                    uuid: 'uuid-human',
                    type: 'user',
                    isSynthetic: false,
                    inputKind: 'human',
                    message: { role: 'user', content: 'an ordinary follow-up' },
                  },
                ]
              : []
          )
        );
        const outerHolder = withContextClearBoundary(
          'test-session-id',
          () => new Promise<void>(() => {})
        );
        const clearSpy = mock(async () => {});
        handler = new QueryModeHandler({
          ...createContext(),
          session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
          slotResetsContext: () => true,
          clearConversationContext: clearSpy,
        });
        const flushing = handler.handleQueryTrigger();

        await expect(flushing).resolves.toBeTruthy();
        expect(clearSpy).not.toHaveBeenCalled();
        expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-task'], 'deferred');
        expect(
          jobsDb
            .prepare(
              `SELECT COUNT(*) AS n FROM job_queue
                WHERE queue = 'message_delivery'
                  AND json_extract(payload, '$.messageUuid') = 'uuid-task'`
            )
            .get()
        ).toEqual({ n: 0 });
        expect(
          jobsDb
            .prepare(
              `SELECT COUNT(*) AS n FROM job_queue
                WHERE queue = 'message_delivery'
                  AND json_extract(payload, '$.messageUuid') = 'uuid-human'`
            )
            .get()
        ).toEqual({ n: 1 });
        void outerHolder;
      } finally {
        if (previousTimeout === undefined)
          delete process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
        else process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = previousTimeout;
        clearContextClearBoundariesForTest();
      }
    });

    it('recomputes the defer set from the refreshed plan so already-owned rows keep their live jobs', async () => {
      const previousTimeout = process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
      process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = '50';
      try {
        getUserMessagesByStatusSpy.mockImplementation((_: string, status: string) =>
          byStatusResult(
            status === 'deferred'
              ? [
                  {
                    dbId: 'db-task-a',
                    uuid: 'uuid-task-a',
                    type: 'user',
                    isSynthetic: true,
                    inputKind: 'task',
                    message: { role: 'user', content: 'row that acquires its own job' },
                  },
                  {
                    dbId: 'db-task-b',
                    uuid: 'uuid-task-b',
                    type: 'user',
                    isSynthetic: true,
                    inputKind: 'task',
                    message: { role: 'user', content: 'row that stays deferred' },
                  },
                ]
              : []
          )
        );
        let releaseOuter!: () => void;
        const outerGate = new Promise<void>((resolve) => {
          releaseOuter = resolve;
        });
        const outerHolder = withContextClearBoundary('test-session-id', () => outerGate);
        const clearSpy = mock(async () => {});
        handler = new QueryModeHandler({
          ...createContext(),
          session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
          slotResetsContext: () => true,
          clearConversationContext: clearSpy,
        });
        const flushing = handler.handleQueryTrigger();
        await new Promise((resolve) => setTimeout(resolve, 10));

        jobQueue.enqueue({
          queue: 'message_delivery',
          payload: {
            sessionId: 'test-session-id',
            messageUuid: 'uuid-task-a',
            role: 'turn',
            origin: 'space_inject',
            parentToolUseId: null,
          },
          maxRetries: 8,
        });

        releaseOuter();
        await outerHolder;
        await expect(flushing).resolves.toBeTruthy();

        expect(clearSpy).not.toHaveBeenCalled();
        expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-task-b'], 'deferred');
        const deferredCalls = updateMessageStatusSpy.mock.calls.filter(
          (call) => call[1] === 'deferred'
        );
        expect(deferredCalls).toHaveLength(1);
      } finally {
        if (previousTimeout === undefined)
          delete process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
        else process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = previousTimeout;
        clearContextClearBoundariesForTest();
      }
    });

    it('re-defers task deliverables when a delivery job appears during the boundary wait', async () => {
      const previousTimeout = process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
      process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = '50';
      try {
        getUserMessagesByStatusSpy.mockImplementation((_: string, status: string) =>
          byStatusResult(
            status === 'deferred'
              ? [
                  {
                    dbId: 'db-task',
                    uuid: 'uuid-task',
                    type: 'user',
                    isSynthetic: true,
                    inputKind: 'task',
                    message: { role: 'user', content: 'the older task row' },
                  },
                ]
              : []
          )
        );
        let releaseOuter!: () => void;
        const outerGate = new Promise<void>((resolve) => {
          releaseOuter = resolve;
        });
        const outerHolder = withContextClearBoundary('test-session-id', () => outerGate);
        const clearSpy = mock(async () => {});
        handler = new QueryModeHandler({
          ...createContext(),
          session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
          slotResetsContext: () => true,
          clearConversationContext: clearSpy,
        });
        const flushing = handler.handleQueryTrigger();
        await new Promise((resolve) => setTimeout(resolve, 10));

        jobQueue.enqueue({
          queue: 'message_delivery',
          payload: {
            sessionId: 'test-session-id',
            messageUuid: 'uuid-chat',
            role: 'turn',
            origin: 'chat',
            parentToolUseId: null,
          },
          maxRetries: 8,
        });

        releaseOuter();
        await outerHolder;
        await expect(flushing).resolves.toBeTruthy();

        expect(clearSpy).not.toHaveBeenCalled();
        expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-task'], 'deferred');
        expect(
          jobsDb
            .prepare(
              `SELECT COUNT(*) AS n FROM job_queue
                WHERE queue = 'message_delivery'
                  AND json_extract(payload, '$.messageUuid') = 'uuid-task'`
            )
            .get()
        ).toEqual({ n: 0 });
      } finally {
        if (previousTimeout === undefined)
          delete process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
        else process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = previousTimeout;
        clearContextClearBoundariesForTest();
      }
    });

    it('a failed flush after re-deferral does not publish the re-deferred rows as enqueued', async () => {
      const previousTimeout = process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
      process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = '50';
      const rows = [
        {
          dbId: 'db-task',
          uuid: 'uuid-task',
          type: 'user',
          isSynthetic: true,
          inputKind: 'task',
          message: { role: 'user', content: 'the older task row' },
        },
        {
          dbId: 'db-human',
          uuid: 'uuid-human',
          type: 'user',
          isSynthetic: false,
          inputKind: 'human',
          message: { role: 'user', content: 'an ordinary follow-up' },
        },
      ] as unknown as SDKMessage[];
      const deferredDbIds = new Set(['db-task', 'db-human']);
      getUserMessagesByStatusSpy.mockImplementation((_: string, status: string) =>
        byStatusResult(status === 'deferred' ? rows.filter((m) => deferredDbIds.has(m.dbId)) : [])
      );
      updateMessageStatusSpy.mockImplementation((ids: string[], status: string) => {
        for (const id of ids) {
          if (status === 'deferred') deferredDbIds.add(id);
          else deferredDbIds.delete(id);
        }
      });
      const enqueue = jobQueue.enqueue.bind(jobQueue);
      try {
        let releaseOuter!: () => void;
        const outerGate = new Promise<void>((resolve) => {
          releaseOuter = resolve;
        });
        const outerHolder = withContextClearBoundary('test-session-id', () => outerGate);
        handler = new QueryModeHandler({
          ...createContext(),
          session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
          slotResetsContext: () => true,
          clearConversationContext: mock(async () => {}),
        });
        const flushing = handler.handleQueryTrigger();
        await new Promise((resolve) => setTimeout(resolve, 10));

        jobQueue.enqueue({
          queue: 'message_delivery',
          payload: {
            sessionId: 'test-session-id',
            messageUuid: 'uuid-live',
            role: 'turn',
            origin: 'chat',
            parentToolUseId: null,
          },
          maxRetries: 8,
        });
        jobQueue.enqueue = mock(() => {
          throw new Error('queue unavailable');
        });

        releaseOuter();
        await outerHolder;
        const result = await flushing;

        expect(result).toMatchObject({ success: false, error: 'queue unavailable' });
        expect(deferredDbIds.has('db-task')).toBe(true);
        const enqueuedCalls = emitSpy.mock.calls.filter(
          (call) => call[1]?.status === 'enqueued' && Array.isArray(call[1]?.messageIds)
        );
        expect(enqueuedCalls).toEqual([
          [
            'messages.statusChanged',
            { sessionId: 'test-session-id', messageIds: ['db-human'], status: 'enqueued' },
          ],
        ]);
      } finally {
        jobQueue.enqueue = enqueue;
        if (previousTimeout === undefined)
          delete process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
        else process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = previousTimeout;
        clearContextClearBoundariesForTest();
      }
    });

    it('admissions wait behind the clear boundary until the flush delivery job is enqueued', async () => {
      const previousTimeout = process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
      process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = '50';
      try {
        getUserMessagesByStatusSpy.mockImplementation((_: string, status: string) =>
          byStatusResult(
            status === 'deferred'
              ? [
                  {
                    dbId: 'db-task',
                    uuid: 'uuid-task',
                    type: 'user',
                    isSynthetic: true,
                    inputKind: 'task',
                    message: { role: 'user', content: 'the older deferred row' },
                  },
                ]
              : []
          )
        );
        let releaseClear!: () => void;
        const clearGate = new Promise<void>((resolve) => {
          releaseClear = resolve;
        });
        const clearSpy = mock(async () => {
          await clearGate;
        });
        handler = new QueryModeHandler({
          ...createContext(),
          session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
          slotResetsContext: () => true,
          clearConversationContext: clearSpy,
        });
        const flushing = handler.handleQueryTrigger();
        await new Promise((resolve) => setTimeout(resolve, 10));

        await expect(
          admitAcrossContextClearBoundary('test-session-id', undefined, async () => 'sent')
        ).resolves.toEqual({ kind: 'boundary_wait' });
        expect(
          jobsDb
            .prepare(`SELECT COUNT(*) AS n FROM job_queue WHERE queue = 'message_delivery'`)
            .get()
        ).toEqual({ n: 0 });

        releaseClear();
        await expect(flushing).resolves.toBeTruthy();
        expect(
          jobsDb
            .prepare(`SELECT COUNT(*) AS n FROM job_queue WHERE queue = 'message_delivery'`)
            .get()
        ).toEqual({ n: 1 });
        await expect(
          admitAcrossContextClearBoundary('test-session-id', undefined, async () => 'sent')
        ).resolves.toEqual({ kind: 'admitted', result: 'sent' });
      } finally {
        if (previousTimeout === undefined)
          delete process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
        else process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = previousTimeout;
        clearContextClearBoundariesForTest();
      }
    });
  });

  describe('durable delivery (v2 default) — task #861 item 3', () => {
    let jobQueue: JobQueueRepository;
    let jobsDb: Database;

    beforeEach(() => {
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
          started_at INTEGER,
          heartbeat_at INTEGER, completed_at INTEGER
        );
        CREATE UNIQUE INDEX uq_message_delivery_active_turn
          ON job_queue (queue, json_extract(payload, '$.sessionId'))
          WHERE queue = 'message_delivery'
            AND json_extract(payload, '$.role') = 'turn'
            AND status IN ('pending', 'processing');
      `);
      jobQueue = new JobQueueRepository(jobsDb as never);
      mockDb = {
        getUserMessagesByStatus: getUserMessagesByStatusSpy,
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
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'one' } },
          { dbId: 'db-2', uuid: 'uuid-2', type: 'user', message: { role: 'user', content: 'two' } },
          {
            dbId: 'db-3',
            uuid: 'uuid-3',
            type: 'user',
            message: { role: 'user', content: 'three' },
          },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1', 'db-2', 'db-3'], 'enqueued');
      const jobs = deliveryUuids();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].uuid).toBe('uuid-1');
      expect(jobs[0].role).toBe('turn');
      const row = jobsDb
        .prepare(`SELECT payload FROM job_queue WHERE queue = 'message_delivery'`)
        .get() as { payload: string };
      expect(JSON.parse(row.payload).batchUuids).toEqual(['uuid-1', 'uuid-2', 'uuid-3']);
      expect(ensureQueryStartedSpy).not.toHaveBeenCalled();
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
    });

    it('handleQueryTrigger with deliverIndividually sends each deferred message as its own job', async () => {
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'one' } },
          { dbId: 'db-2', uuid: 'uuid-2', type: 'user', message: { role: 'user', content: 'two' } },
          {
            dbId: 'db-3',
            uuid: 'uuid-3',
            type: 'user',
            message: { role: 'user', content: 'three' },
          },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger({ deliverIndividually: true });

      expect(result).toEqual({ success: true, messageCount: 3 });
      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1', 'db-2', 'db-3'], 'enqueued');
      const jobs = deliveryUuids();
      expect(jobs.map((j) => j.uuid)).toEqual(['uuid-1', 'uuid-2', 'uuid-3']);
      expect(jobs.find((j) => j.uuid === 'uuid-1')?.role).toBe('turn');
      expect(jobs.filter((j) => j.role === 'steer')).toHaveLength(2);
      const payloads = jobsDb
        .prepare(`SELECT payload FROM job_queue WHERE queue = 'message_delivery'`)
        .all() as Array<{ payload: string }>;
      expect(payloads.every((p) => !('batchUuids' in JSON.parse(p.payload)))).toBe(true);
    });

    it('handleQueryTrigger with excludeMessageUuid leaves the excluded row deferred', async () => {
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'one' } },
          { dbId: 'db-2', uuid: 'uuid-2', type: 'user', message: { role: 'user', content: 'two' } },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger({
        deliverIndividually: true,
        excludeMessageUuid: 'uuid-2',
      });

      expect(result).toEqual({ success: true, messageCount: 1 });
      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1'], 'enqueued');
      const jobs = deliveryUuids();
      expect(jobs.map((j) => j.uuid)).toEqual(['uuid-1']);
    });

    it('handleQueryTrigger creates durable ownership before publishing enqueued status', async () => {
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'one' } },
        ] as unknown as SDKMessage[])
      );
      let ownedWhenPublished = false;
      emitSpy.mockImplementation(async (event: string) => {
        if (event === 'messages.statusChanged') {
          ownedWhenPublished = jobQueue.activeDeliveryMessageUuids('test-session-id').has('uuid-1');
        }
      });

      handler = new QueryModeHandler(createContext());
      await handler.handleQueryTrigger();

      expect(ownedWhenPublished).toBe(true);
    });

    it('handleQueryTrigger publishes enqueued status when durable enqueue fails', async () => {
      getUserMessagesByStatusSpy.mockImplementation((_: string, status: string) =>
        byStatusResult(
          status === 'deferred'
            ? ([
                {
                  dbId: 'db-1',
                  uuid: 'uuid-1',
                  type: 'user',
                  message: { role: 'user', content: 'one' },
                },
              ] as unknown as SDKMessage[])
            : []
        )
      );
      const enqueue = jobQueue.enqueue.bind(jobQueue);
      jobQueue.enqueue = mock(() => {
        throw new Error('queue unavailable');
      });

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: false, messageCount: 0, error: 'queue unavailable' });
      expect(emitSpy).toHaveBeenCalledWith('messages.statusChanged', {
        sessionId: 'test-session-id',
        messageIds: ['db-1'],
        status: 'enqueued',
      });
      jobQueue.enqueue = enqueue;
    });

    it('handleQueryTrigger falls back to per-message jobs when a turn is already active', async () => {
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
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'one' } },
          { dbId: 'db-2', uuid: 'uuid-2', type: 'user', message: { role: 'user', content: 'two' } },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 2 });
      const jobs = deliveryUuids();
      expect(jobs.map((j) => j.uuid).sort()).toEqual(['uuid-1', 'uuid-2', 'uuid-active']);
      expect(jobs.filter((j) => j.role === 'steer')).toHaveLength(2);
      const payloads = jobsDb
        .prepare(`SELECT payload FROM job_queue WHERE queue = 'message_delivery'`)
        .all() as Array<{ payload: string }>;
      expect(payloads.every((p) => !('batchUuids' in JSON.parse(p.payload)))).toBe(true);
    });

    it('handleQueryTrigger does NOT batch a mixed flush (image between texts preserves queue order)', async () => {
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
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
          {
            dbId: 'db-3',
            uuid: 'uuid-3',
            type: 'user',
            message: { role: 'user', content: 'three' },
          },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
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
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          {
            dbId: 'db-1',
            uuid: 'uuid-1',
            type: 'user',
            message: { role: 'user', content: '/compact' },
          },
          {
            dbId: 'db-2',
            uuid: 'uuid-2',
            type: 'user',
            message: { role: 'user', content: 'note' },
          },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 2 });
      const jobs = deliveryUuids();
      expect(jobs).toHaveLength(2);
      expect(jobs.find((j) => j.uuid === 'uuid-1')?.role).toBe('turn');
      expect(jobs.find((j) => j.uuid === 'uuid-2')?.role).toBe('steer');
    });

    it('handleQueryTrigger skips batch-owned members in the per-message fallback (replay race)', async () => {
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
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'one' } },
          { dbId: 'db-2', uuid: 'uuid-2', type: 'user', message: { role: 'user', content: 'two' } },
          {
            dbId: 'db-3',
            uuid: 'uuid-3',
            type: 'user',
            message: { role: 'user', content: 'three' },
          },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      const jobs = deliveryUuids();
      expect(jobs.map((j) => j.uuid)).toEqual(['uuid-1']);
      expect(jobs[0].role).toBe('turn');
    });

    it('sendEnqueuedMessagesOnTurnEnd enqueues a durable job per enqueued message', async () => {
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'q' } },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler(createContext());
      await handler.sendEnqueuedMessagesOnTurnEnd();

      const jobs = deliveryUuids();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].uuid).toBe('uuid-1');
      expect(jobs[0].role).toBe('turn');
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
    });

    it('sendEnqueuedMessagesOnTurnEnd skips v2 delivery owned by the durable queue', async () => {
      jobQueue.enqueue({
        queue: 'message_delivery',
        payload: {
          sessionId: 'test-session-id',
          messageUuid: 'uuid-owned',
          role: 'turn',
          origin: 'chat',
          parentToolUseId: null,
        },
      });
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          {
            dbId: 'db-owned',
            uuid: 'uuid-owned',
            type: 'user',
            message: { role: 'user', content: 'already durable' },
          },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler(createContext());
      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(deliveryUuids()).toEqual([{ uuid: 'uuid-owned', role: 'turn' }]);
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(ensureQueryStartedSpy).not.toHaveBeenCalled();
    });

    it('sendEnqueuedMessagesOnTurnEnd skips v2 delivery owned by the in-memory queue', async () => {
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          {
            dbId: 'db-owned',
            uuid: 'uuid-owned',
            type: 'user',
            message: { role: 'user', content: 'already admitted' },
          },
        ] as unknown as SDKMessage[])
      );
      hasPendingOrInFlightSpy.mockImplementation((uuid: string) => uuid === 'uuid-owned');

      handler = new QueryModeHandler(createContext());
      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(deliveryUuids()).toEqual([]);
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(ensureQueryStartedSpy).not.toHaveBeenCalled();
    });

    it('excludes re-deferred task rows from the trailing enqueued announce', async () => {
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
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          {
            dbId: 'db-human',
            uuid: 'uuid-human',
            type: 'user',
            isSynthetic: false,
            inputKind: 'human',
            message: { role: 'user', content: 'a human follow-up' },
          },
          {
            dbId: 'db-task',
            uuid: 'uuid-task',
            type: 'user',
            isSynthetic: true,
            inputKind: 'task',
            message: { role: 'user', content: 'handoff' },
          },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler({
        ...createContext(),
        session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
        slotResetsContext: () => true,
        clearConversationContext: async () => {},
      });
      await handler.handleQueryTrigger();

      const events = emitSpy.mock.calls
        .filter(([event]) => event === 'messages.statusChanged')
        .map(([, payload]) => payload as { status: string; messageIds: string[] });
      const enqueuedIds = events
        .filter((p) => p.status === 'enqueued')
        .flatMap((p) => p.messageIds);
      const deferredIds = events
        .filter((p) => p.status === 'deferred')
        .flatMap((p) => p.messageIds);
      expect(deferredIds).toEqual(['db-task']);
      expect(enqueuedIds).toContain('db-human');
      expect(enqueuedIds).not.toContain('db-task');
    });

    it('replay defers the deferred-task pass while the replayed human job is active', async () => {
      const clearSpy = mock(async () => {});
      getUserMessagesByStatusSpy.mockImplementation((_: string, status: string) =>
        byStatusResult(
          status === 'enqueued'
            ? [
                {
                  dbId: 'db-human',
                  uuid: 'uuid-human',
                  type: 'user',
                  isSynthetic: false,
                  inputKind: 'human',
                  message: { role: 'user', content: 'a human follow-up' },
                },
              ]
            : [
                {
                  dbId: 'db-task',
                  uuid: 'uuid-task',
                  type: 'user',
                  isSynthetic: true,
                  inputKind: 'task',
                  message: { role: 'user', content: 'the deferred task' },
                },
              ]
        )
      );

      handler = new QueryModeHandler({
        ...createContext(),
        session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
        slotResetsContext: () => true,
        clearConversationContext: clearSpy,
      });
      await handler.replayPendingMessagesForImmediateMode();

      expect(clearSpy).not.toHaveBeenCalled();
      const jobs = deliveryUuids();
      expect(jobs).toEqual([{ uuid: 'uuid-human', role: 'turn' }]);
      expect(updateMessageStatusSpy).not.toHaveBeenCalled();
    });

    it('handleQueryTrigger clears exactly once before the durable batch job is created (#1085)', async () => {
      const order: string[] = [];
      const clearSpy = mock(async () => {
        order.push('clear');
      });
      const enqueue = jobQueue.enqueue.bind(jobQueue);
      jobQueue.enqueue = mock((...args: Parameters<typeof enqueue>) => {
        order.push('job');
        return enqueue(...args);
      });
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          {
            dbId: 'db-1',
            uuid: 'uuid-1',
            type: 'user',
            isSynthetic: true,
            message: { role: 'user', content: 'one' },
          },
          {
            dbId: 'db-2',
            uuid: 'uuid-2',
            type: 'user',
            isSynthetic: true,
            message: { role: 'user', content: 'two' },
          },
          {
            dbId: 'db-3',
            uuid: 'uuid-3',
            type: 'user',
            isSynthetic: true,
            message: { role: 'user', content: 'three' },
          },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler({
        ...createContext(),
        session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
        slotResetsContext: () => true,
        clearConversationContext: clearSpy,
      });
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      expect(order).toEqual(['clear', 'job']);
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(deliveryUuids()).toHaveLength(1);
      jobQueue.enqueue = enqueue;
    });
  });
});

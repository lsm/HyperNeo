import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
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
import { createTestDb } from '../../../helpers/database';

const SESSION_ID = 'test-session-id';

interface RecordedStatusEvent {
  messageIds: string[];
  status: string;
}

function userRow(
  uuid: string,
  text: string,
  extra?: { isSynthetic?: boolean; inputKind?: string }
): SDKUserMessage {
  return {
    type: 'user',
    uuid,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    isSynthetic: extra?.isSynthetic,
    inputKind: extra?.inputKind,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  } as unknown as SDKUserMessage;
}

describe('QueryModeHandler', () => {
  let mockSession: Session;
  let db: Database;
  let mockMessageQueue: MessageQueue;
  let mockLogger: Logger;
  let statusEvents: RecordedStatusEvent[];
  let mockInternalEventBus: InternalEventBus<any>;
  let ensureQueryStartedSpy: ReturnType<typeof mock>;
  let hasPendingOrInFlightImpl: (uuid: string) => boolean;

  function seedRow(
    uuid: string,
    text: string,
    sendStatus: 'deferred' | 'enqueued',
    extra?: { isSynthetic?: boolean; inputKind?: string }
  ): string {
    return db.saveUserMessage(SESSION_ID, userRow(uuid, text, extra), sendStatus);
  }

  function rawDb() {
    return db.getDatabase();
  }

  function sendStatusByUuid(uuid: string): string | undefined {
    const row = rawDb()
      .prepare(`SELECT send_status FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?`)
      .get(SESSION_ID, uuid) as { send_status: string } | undefined;
    return row?.send_status;
  }

  function deliveryUuids(): Array<{ uuid: string }> {
    return (
      rawDb()
        .prepare(
          `SELECT json_extract(payload, '$.messageUuid') AS uuid
             FROM job_queue WHERE queue = 'message_delivery'
            ORDER BY created_at ASC, rowid ASC`
        )
        .all() as Array<{ uuid: string | null }>
    ).map((row) => ({ uuid: row.uuid ?? '' }));
  }

  function deliveryPayload(uuid: string): Record<string, unknown> | null {
    const row = rawDb()
      .prepare(
        `SELECT payload FROM job_queue
          WHERE queue = 'message_delivery'
            AND json_extract(payload, '$.messageUuid') = ?
          LIMIT 1`
      )
      .get(uuid) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as Record<string, unknown>) : null;
  }

  beforeEach(async () => {
    db = await createTestDb();
    statusEvents = [];
    mockSession = {
      id: SESSION_ID,
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
    db.createSession(mockSession);

    mockInternalEventBus = {
      publish: mock(async (event: string, payload: { messageIds?: string[]; status?: string }) => {
        if (event === 'messages.statusChanged') {
          statusEvents.push({
            messageIds: payload.messageIds ?? [],
            status: payload.status ?? '',
          });
        }
        return { delivered: 1, failures: [] };
      }),
      publishAsync: mock(async () => {}),
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;

    hasPendingOrInFlightImpl = () => false;
    mockMessageQueue = {
      enqueueWithId: mock(async () => {}),
      hasPendingOrInFlight: mock((uuid: string) => hasPendingOrInFlightImpl(uuid)),
      size: mock(() => 0),
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

  afterEach(async () => {
    clearContextClearBoundariesForTest();
    db.getDatabase().close();
  });

  function createContext(): QueryModeHandlerContext {
    return {
      session: mockSession,
      db,
      internalEventBus: mockInternalEventBus,
      messageQueue: mockMessageQueue,
      logger: mockLogger,
      ensureQueryStarted: ensureQueryStartedSpy,
    };
  }

  function createHandler(context?: Partial<QueryModeHandlerContext>): QueryModeHandler {
    return new QueryModeHandler({ ...createContext(), ...context });
  }

  describe('clear_then_flush boundary hold (v2)', () => {
    it('defers the flush instead of clearing unprotected when the boundary stays busy', async () => {
      const previousTimeout = process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
      process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = '50';
      try {
        seedRow('uuid-task', 'the older task row', 'deferred', {
          isSynthetic: true,
          inputKind: 'task',
        });
        seedRow('uuid-human', 'an ordinary follow-up', 'deferred');
        const outerHolder = withContextClearBoundary(SESSION_ID, () => new Promise<void>(() => {}));
        const clearSpy = mock(async () => {});
        const handler = createHandler({
          session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
          slotResetsContext: () => true,
          clearConversationContext: clearSpy,
        });
        const flushing = handler.handleQueryTrigger();

        await expect(flushing).resolves.toBeTruthy();
        expect(clearSpy).not.toHaveBeenCalled();
        expect(sendStatusByUuid('uuid-task')).toBe('deferred');
        expect(deliveryUuids().filter((job) => job.uuid === 'uuid-task')).toEqual([]);
        expect(deliveryUuids().filter((job) => job.uuid === 'uuid-human')).toHaveLength(1);
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
        seedRow('uuid-task-a', 'row that acquires its own job', 'deferred', {
          isSynthetic: true,
          inputKind: 'task',
        });
        seedRow('uuid-task-b', 'row that stays deferred', 'deferred', {
          isSynthetic: true,
          inputKind: 'task',
        });
        let releaseOuter!: () => void;
        const outerGate = new Promise<void>((resolve) => {
          releaseOuter = resolve;
        });
        const outerHolder = withContextClearBoundary(SESSION_ID, () => outerGate);
        const clearSpy = mock(async () => {});
        const handler = createHandler({
          session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
          slotResetsContext: () => true,
          clearConversationContext: clearSpy,
        });
        const flushing = handler.handleQueryTrigger();
        await new Promise((resolve) => setTimeout(resolve, 10));

        db.getJobQueueRepo().enqueue({
          queue: 'message_delivery',
          payload: {
            sessionId: SESSION_ID,
            messageUuid: 'uuid-task-a',
            origin: 'space_inject',
            parentToolUseId: null,
          },
          maxRetries: 8,
        });

        releaseOuter();
        await outerHolder;
        await expect(flushing).resolves.toBeTruthy();

        expect(clearSpy).not.toHaveBeenCalled();
        expect(sendStatusByUuid('uuid-task-b')).toBe('deferred');
        expect(deliveryUuids().filter((job) => job.uuid === 'uuid-task-b')).toEqual([]);
        expect(deliveryUuids().filter((job) => job.uuid === 'uuid-task-a')).toHaveLength(1);
        expect(
          statusEvents.filter((event) => event.status === 'deferred' && event.messageIds.length > 0)
        ).toEqual([]);
      } finally {
        if (previousTimeout === undefined)
          delete process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
        else process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = previousTimeout;
        clearContextClearBoundariesForTest();
      }
    });

    it('leaves task deliverables deferred when a delivery job appears during the boundary wait', async () => {
      const previousTimeout = process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
      process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = '50';
      try {
        seedRow('uuid-task', 'the older task row', 'deferred', {
          isSynthetic: true,
          inputKind: 'task',
        });
        let releaseOuter!: () => void;
        const outerGate = new Promise<void>((resolve) => {
          releaseOuter = resolve;
        });
        const outerHolder = withContextClearBoundary(SESSION_ID, () => outerGate);
        const clearSpy = mock(async () => {});
        const handler = createHandler({
          session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
          slotResetsContext: () => true,
          clearConversationContext: clearSpy,
        });
        const flushing = handler.handleQueryTrigger();
        await new Promise((resolve) => setTimeout(resolve, 10));

        db.getJobQueueRepo().enqueue({
          queue: 'message_delivery',
          payload: {
            sessionId: SESSION_ID,
            messageUuid: 'uuid-chat',
            origin: 'chat',
            parentToolUseId: null,
          },
          maxRetries: 8,
        });

        releaseOuter();
        await outerHolder;
        await expect(flushing).resolves.toBeTruthy();

        expect(clearSpy).not.toHaveBeenCalled();
        expect(sendStatusByUuid('uuid-task')).toBe('deferred');
        expect(deliveryUuids().filter((job) => job.uuid === 'uuid-task')).toEqual([]);
      } finally {
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
        seedRow('uuid-task', 'the older deferred row', 'deferred', {
          isSynthetic: true,
          inputKind: 'task',
        });
        let releaseClear!: () => void;
        const clearGate = new Promise<void>((resolve) => {
          releaseClear = resolve;
        });
        const clearSpy = mock(async () => {
          await clearGate;
        });
        const handler = createHandler({
          session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
          slotResetsContext: () => true,
          clearConversationContext: clearSpy,
        });
        const flushing = handler.handleQueryTrigger();
        await new Promise((resolve) => setTimeout(resolve, 10));

        await expect(
          admitAcrossContextClearBoundary(SESSION_ID, undefined, async () => 'sent')
        ).resolves.toEqual({ kind: 'boundary_wait' });
        expect(deliveryUuids()).toEqual([]);

        releaseClear();
        await expect(flushing).resolves.toBeTruthy();
        expect(deliveryUuids()).toHaveLength(1);
        await expect(
          admitAcrossContextClearBoundary(SESSION_ID, undefined, async () => 'sent')
        ).resolves.toEqual({ kind: 'admitted', result: 'sent' });
      } finally {
        if (previousTimeout === undefined)
          delete process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
        else process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = previousTimeout;
        clearContextClearBoundariesForTest();
      }
    });
  });

  describe('outbox flush (activate-prompts producer)', () => {
    it('delivers each deferred message as its own durable job in backlog order', async () => {
      seedRow('uuid-1', 'one', 'deferred');
      seedRow('uuid-2', 'two', 'deferred');
      seedRow('uuid-3', 'three', 'deferred');

      const handler = createHandler();
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      const jobs = deliveryUuids();
      expect(jobs.map((job) => job.uuid)).toEqual(['uuid-1', 'uuid-2', 'uuid-3']);
      expect(jobs.every((job) => deliveryPayload(job.uuid)?.role === undefined)).toBe(true);
      expect(jobs.every((job) => deliveryPayload(job.uuid)?.batchUuids === undefined)).toBe(true);
      for (const uuid of ['uuid-1', 'uuid-2', 'uuid-3']) {
        expect(sendStatusByUuid(uuid)).toBe('enqueued');
        expect(deliveryPayload(uuid)?.released).toBe(true);
      }
      expect(statusEvents).toEqual([
        { messageIds: jobs.map(() => expect.any(String)), status: 'enqueued' },
      ]);
      expect(statusEvents[0].messageIds).toHaveLength(3);
      expect(ensureQueryStartedSpy).not.toHaveBeenCalled();
    });

    it('accepts deliverIndividually without changing the per-message delivery', async () => {
      seedRow('uuid-1', 'one', 'deferred');
      seedRow('uuid-2', 'two', 'deferred');

      const handler = createHandler();
      const result = await handler.handleQueryTrigger({ deliverIndividually: true });

      expect(result).toEqual({ success: true, messageCount: 2 });
      expect(deliveryUuids().map((job) => job.uuid)).toEqual(['uuid-1', 'uuid-2']);
    });

    it('leaves the excluded row deferred when excludeMessageUuid is set', async () => {
      seedRow('uuid-1', 'one', 'deferred');
      seedRow('uuid-2', 'two', 'deferred');

      const handler = createHandler();
      const result = await handler.handleQueryTrigger({
        deliverIndividually: true,
        excludeMessageUuid: 'uuid-2',
      });

      expect(result).toEqual({ success: true, messageCount: 1 });
      expect(deliveryUuids().map((job) => job.uuid)).toEqual(['uuid-1']);
      expect(sendStatusByUuid('uuid-2')).toBe('deferred');
      expect(statusEvents[0].messageIds).toHaveLength(1);
    });

    it('creates durable ownership before publishing enqueued status', async () => {
      seedRow('uuid-1', 'one', 'deferred');
      let ownedWhenPublished = false;
      const publishSpy = mockInternalEventBus.publish as ReturnType<typeof mock>;
      publishSpy.mockImplementation(
        async (event: string, payload: { messageIds?: string[]; status?: string }) => {
          if (event === 'messages.statusChanged') {
            statusEvents.push({
              messageIds: payload.messageIds ?? [],
              status: payload.status ?? '',
            });
            if (payload.status === 'enqueued') {
              ownedWhenPublished = db
                .getJobQueueRepo()
                .activeDeliveryMessageUuids(SESSION_ID)
                .has('uuid-1');
            }
          }
          return { delivered: 1, failures: [] };
        }
      );

      const handler = createHandler();
      await handler.handleQueryTrigger();

      expect(statusEvents).toHaveLength(1);
      expect(ownedWhenPublished).toBe(true);
    });

    it('rolls the activation back whole when the enqueue fails (no stranded row, no status event)', async () => {
      seedRow('uuid-1', 'one', 'deferred');
      const jobQueue = db.getJobQueueRepo();
      const enqueue = jobQueue.enqueue.bind(jobQueue);
      jobQueue.enqueue = mock(() => {
        throw new Error('queue unavailable');
      });

      const handler = createHandler();
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: false, messageCount: 0, error: 'queue unavailable' });
      expect(sendStatusByUuid('uuid-1')).toBe('deferred');
      expect(deliveryUuids()).toEqual([]);
      expect(statusEvents).toEqual([]);
      jobQueue.enqueue = enqueue;
    });

    it('enqueues FIFO siblings when a delivery job is already active', async () => {
      db.getJobQueueRepo().enqueue({
        queue: 'message_delivery',
        payload: {
          sessionId: SESSION_ID,
          messageUuid: 'uuid-active',
          origin: 'chat',
          parentToolUseId: null,
        },
      });
      seedRow('uuid-1', 'one', 'deferred');
      seedRow('uuid-2', 'two', 'deferred');

      const handler = createHandler();
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 2 });
      const jobs = deliveryUuids();
      expect(jobs.map((job) => job.uuid).sort()).toEqual(['uuid-1', 'uuid-2', 'uuid-active']);
      expect(jobs.every((job) => deliveryPayload(job.uuid)?.role === undefined)).toBe(true);
      expect(jobs.every((job) => deliveryPayload(job.uuid)?.batchUuids === undefined)).toBe(true);
    });

    it('preserves queue order for a mixed flush (image between texts)', async () => {
      const imageMessage = {
        type: 'user',
        uuid: 'uuid-2',
        session_id: SESSION_ID,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64' } }],
        },
      } as unknown as SDKMessage;
      db.saveUserMessage(SESSION_ID, imageMessage, 'deferred');
      seedRow('uuid-1', 'one', 'deferred');
      seedRow('uuid-3', 'three', 'deferred');
      const backlog = db.getUserMessagesByStatus(SESSION_ID, 'deferred').messages;
      expect(backlog.map((row) => row.uuid)).toEqual(['uuid-2', 'uuid-1', 'uuid-3']);

      const handler = createHandler();
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      const jobs = deliveryUuids();
      expect(jobs.map((job) => job.uuid)).toEqual(['uuid-2', 'uuid-1', 'uuid-3']);
      expect(jobs.every((job) => deliveryPayload(job.uuid)?.batchUuids === undefined)).toBe(true);
    });

    it('skips job-queue-owned rows (replay race with existing delivery jobs)', async () => {
      db.getJobQueueRepo().enqueue({
        queue: 'message_delivery',
        payload: {
          sessionId: SESSION_ID,
          messageUuid: 'uuid-1',
          origin: 'recovery',
          parentToolUseId: null,
        },
      });
      db.getJobQueueRepo().enqueue({
        queue: 'message_delivery',
        payload: {
          sessionId: SESSION_ID,
          messageUuid: 'uuid-2',
          origin: 'recovery',
          parentToolUseId: null,
        },
      });
      seedRow('uuid-1', 'one', 'deferred');
      seedRow('uuid-2', 'two', 'deferred');
      seedRow('uuid-3', 'three', 'deferred');

      const handler = createHandler();
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      expect(deliveryUuids().map((job) => job.uuid)).toEqual(['uuid-1', 'uuid-2', 'uuid-3']);
      expect(sendStatusByUuid('uuid-3')).toBe('enqueued');
      expect(statusEvents).toEqual([{ messageIds: [expect.any(String)], status: 'enqueued' }]);
    });

    it('sendEnqueuedMessagesOnTurnEnd re-arms a durable job per enqueued message', async () => {
      seedRow('uuid-1', 'q', 'enqueued');

      const handler = createHandler();
      const outcome = await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(outcome.replayedWork).toBe(true);
      const jobs = deliveryUuids();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].uuid).toBe('uuid-1');
      expect(deliveryPayload('uuid-1')?.released).toBe(true);
      expect(mockMessageQueue.enqueueWithId).not.toHaveBeenCalled();
    });

    it('sendEnqueuedMessagesOnTurnEnd skips v2 delivery owned by the durable queue', async () => {
      db.getJobQueueRepo().enqueue({
        queue: 'message_delivery',
        payload: {
          sessionId: SESSION_ID,
          messageUuid: 'uuid-owned',
          origin: 'chat',
          parentToolUseId: null,
        },
      });
      seedRow('uuid-owned', 'already durable', 'enqueued');

      const handler = createHandler();
      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(deliveryUuids()).toEqual([{ uuid: 'uuid-owned' }]);
      expect(mockMessageQueue.enqueueWithId).not.toHaveBeenCalled();
      expect(ensureQueryStartedSpy).not.toHaveBeenCalled();
    });

    it('sendEnqueuedMessagesOnTurnEnd skips v2 delivery owned by the in-memory queue', async () => {
      seedRow('uuid-owned', 'already admitted', 'enqueued');
      hasPendingOrInFlightImpl = (uuid: string) => uuid === 'uuid-owned';

      const handler = createHandler();
      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(deliveryUuids()).toEqual([]);
      expect(mockMessageQueue.enqueueWithId).not.toHaveBeenCalled();
      expect(ensureQueryStartedSpy).not.toHaveBeenCalled();
    });

    it('keeps task rows deferred and out of the enqueued announce while a turn is active', async () => {
      db.getJobQueueRepo().enqueue({
        queue: 'message_delivery',
        payload: {
          sessionId: SESSION_ID,
          messageUuid: 'uuid-active',
          origin: 'chat',
          parentToolUseId: null,
        },
      });
      seedRow('uuid-human', 'a human follow-up', 'deferred', { inputKind: 'human' });
      seedRow('uuid-task', 'handoff', 'deferred', { isSynthetic: true, inputKind: 'task' });

      const handler = createHandler({
        session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
        slotResetsContext: () => true,
        clearConversationContext: async () => {},
      });
      await handler.handleQueryTrigger();

      expect(sendStatusByUuid('uuid-task')).toBe('deferred');
      expect(deliveryUuids().filter((job) => job.uuid === 'uuid-task')).toEqual([]);
      const enqueuedIds = statusEvents
        .filter((event) => event.status === 'enqueued')
        .flatMap((event) => event.messageIds);
      expect(enqueuedIds).toHaveLength(1);
      expect(sendStatusByUuid('uuid-human')).toBe('enqueued');
      expect(
        statusEvents.filter((event) => event.status === 'deferred' && event.messageIds.length > 0)
      ).toEqual([]);
    });

    it('re-defers task rows found in the enqueued lane when a turn is active', async () => {
      db.getJobQueueRepo().enqueue({
        queue: 'message_delivery',
        payload: {
          sessionId: SESSION_ID,
          messageUuid: 'uuid-active',
          origin: 'chat',
          parentToolUseId: null,
        },
      });
      seedRow('uuid-task', 'handoff', 'enqueued', { isSynthetic: true, inputKind: 'task' });

      const handler = createHandler({
        session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
        slotResetsContext: () => true,
        clearConversationContext: async () => {},
      });
      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(sendStatusByUuid('uuid-task')).toBe('deferred');
      expect(deliveryUuids().filter((job) => job.uuid === 'uuid-task')).toEqual([]);
      expect(statusEvents).toEqual([{ messageIds: [expect.any(String)], status: 'deferred' }]);
    });

    it('replay defers the deferred-task pass while the replayed human job is active', async () => {
      const clearSpy = mock(async () => {});
      seedRow('uuid-human', 'a human follow-up', 'enqueued', { inputKind: 'human' });
      seedRow('uuid-task', 'the deferred task', 'deferred', {
        isSynthetic: true,
        inputKind: 'task',
      });

      const handler = createHandler({
        session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
        slotResetsContext: () => true,
        clearConversationContext: clearSpy,
      });
      await handler.replayPendingMessagesForImmediateMode();

      expect(clearSpy).not.toHaveBeenCalled();
      expect(deliveryUuids()).toEqual([{ uuid: 'uuid-human' }]);
      expect(sendStatusByUuid('uuid-task')).toBe('deferred');
    });

    it('clears exactly once before the durable jobs are created (#1085)', async () => {
      const order: string[] = [];
      const clearSpy = mock(async () => {
        order.push('clear');
      });
      const jobQueue = db.getJobQueueRepo();
      const enqueue = jobQueue.enqueue.bind(jobQueue);
      jobQueue.enqueue = mock((...args: Parameters<typeof enqueue>) => {
        order.push('job');
        return enqueue(...args);
      });
      seedRow('uuid-1', 'one', 'deferred', { isSynthetic: true });
      seedRow('uuid-2', 'two', 'deferred', { isSynthetic: true });
      seedRow('uuid-3', 'three', 'deferred', { isSynthetic: true });

      const handler = createHandler({
        session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
        slotResetsContext: () => true,
        clearConversationContext: clearSpy,
      });
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      expect(order[0]).toBe('clear');
      expect(order.slice(1).every((entry) => entry === 'job')).toBe(true);
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(deliveryUuids()).toHaveLength(3);
      jobQueue.enqueue = enqueue;
    });

    it('rethrows ClearConversationCancelledError instead of swallowing it as a flush failure', async () => {
      seedRow('uuid-task', 'the older deferred row', 'deferred', {
        isSynthetic: true,
        inputKind: 'task',
      });
      const handler = createHandler({
        session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
        slotResetsContext: () => true,
        clearConversationContext: async () => {
          throw new ClearConversationCancelledError();
        },
      });

      await expect(handler.handleQueryTrigger()).rejects.toBeInstanceOf(
        ClearConversationCancelledError
      );
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { MessageHub, Session } from '@hyperneo/shared';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { buildBatchedDeliveryContent } from '../../../../src/lib/agent/message-delivery.ts';
import type { QueryLike } from '../../../../src/lib/agent/query-like.ts';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { setModelsCache } from '../../../../src/lib/model-service';
import { resetProviderRegistry } from '../../../../src/lib/providers/registry';
import type { Database } from '../../../../src/storage/database.ts';

function makeEventBus(): InternalEventBus<DaemonInternalEventMap> {
  return {
    publish: mock(async () => {}),
    publishAsync: mock(() => {}),
    subscribe: mock((_: string, __: () => void, ___: { subscriberName: string }) => () => {}),
  } as unknown as InternalEventBus<DaemonInternalEventMap>;
}

function createAgentSession(): AgentSession {
  const mockSession: Session = {
    id: `mid-turn-${Math.random()}`,
    title: 'Mid-turn budget session',
    workspacePath: '/test/workspace',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: {
      model: 'some-model',
      provider: 'openrouter',
      maxTokens: 8192,
      temperature: 1.0,
    },
    metadata: {},
  } as Session;

  const mockDb = {
    getSession: mock(() => mockSession),
    updateSession: mock(() => {}),
    getUserMessages: mock(() => []),
    getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
    getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
    saveSDKMessage: mock(() => true),
    deleteMessagesAfter: mock(() => 0),
    deleteMessagesAtAndAfter: mock(() => 0),
    getUserMessageByUuid: mock(() => undefined),
    countMessagesAfter: mock(() => 0),
    updateMessage: mock(() => {}),
    getSDKMessageCount: mock(() => 0),
    getConsumedUserMessagesAfter: mock(() => []),
    getMessageByStatusAndUuid: mock(() => undefined),
    getSDKMessageRepo: mock(() => ({
      getUserMessageContentByUuid: mock(() => null),
      markDeliveryRetryableByUuid: mock(() => null),
    })),
  } as unknown as Database;

  const session = new AgentSession(
    mockSession,
    mockDb,
    { event: mock(() => {}) } as MessageHub,
    makeEventBus(),
    mock(async () => 'test-api-key')
  );
  session.messageQueue.start();
  void session.stateManager.setProcessing('mid-turn-fixture');
  return session;
}

function makeUsageResponse() {
  return {
    totalTokens: 190_000,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    percentage: 95,
    categories: [{ name: 'context', tokens: 190_000 }],
    isAutoCompactEnabled: false,
  };
}

interface QueryHarness {
  query: QueryLike;
  setInterruptResult: (impl: () => Promise<{ still_queued: string[] } | undefined>) => void;
  cancelMock: ReturnType<typeof mock>;
  usageMock: ReturnType<typeof mock>;
  interruptMock: ReturnType<typeof mock>;
}

function makeQuery(): QueryHarness {
  const cancelMock = mock(async (_uuid: string) => true);
  const usageMock = mock(async () => makeUsageResponse());
  const interruptMock = mock(() => {});
  const state: { interruptImpl: () => Promise<{ still_queued: string[] } | undefined> } = {
    interruptImpl: async () => ({ still_queued: [] }),
  };
  const query = {
    async *[Symbol.asyncIterator]() {},
    interrupt: () => interruptMock() as unknown as ReturnType<typeof state.interruptImpl>,
    cancelAsyncMessage: (uuid: string) => cancelMock(uuid),
    getContextUsage: () => usageMock(),
    close: () => {},
  } as unknown as QueryLike;
  interruptMock.mockImplementation(() => state.interruptImpl());
  return {
    query,
    setInterruptResult: (impl) => {
      state.interruptImpl = impl;
    },
    cancelMock,
    usageMock,
    interruptMock,
  };
}

async function tick(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AgentSession mid-turn context budget enforcement', () => {
  beforeEach(() => {
    setModelsCache(new Map());
  });

  afterEach(() => {
    setModelsCache(new Map());
    resetProviderRegistry();
  });

  it('requeues a cancelled survivor durably under its original id', async () => {
    const session = createAgentSession();
    const harness = makeQuery();
    session.queryObject = harness.query;
    session.messageQueue.noteInternalCompactionSent({
      id: 'uuid-a',
      content: 'finish the deploy',
      internal: false,
    } as never);
    harness.setInterruptResult(async () => ({ still_queued: ['uuid-a'] }));
    const enqueueSpy = spyOn(session.messageQueue, 'enqueueWithId').mockResolvedValue(undefined);

    await session.midTurnContextBudgetCheck();

    expect(harness.cancelMock).toHaveBeenCalledTimes(1);
    expect(harness.cancelMock).toHaveBeenCalledWith('uuid-a');
    expect(enqueueSpy).toHaveBeenCalledWith('uuid-a', 'finish the deploy', false, {
      durable: true,
      prepend: true,
    });
  });

  it('cancels survivors even while an internal compaction is queued locally', async () => {
    const session = createAgentSession();
    const harness = makeQuery();
    session.queryObject = harness.query;
    void session.messageQueue.admitWithId('compact-queued', '/compact', true, { durable: true });
    expect(session.messageQueue.hasOutstandingInternalCompaction()).toBe(true);
    session.messageQueue.noteInternalCompactionSent({
      id: 'uuid-c',
      content: 'ship the release',
      internal: false,
    } as never);
    harness.setInterruptResult(async () => ({ still_queued: ['uuid-c'] }));
    const enqueueSpy = spyOn(session.messageQueue, 'enqueueWithId').mockResolvedValue(undefined);

    await session.midTurnContextBudgetCheck();

    expect(harness.cancelMock).toHaveBeenCalledWith('uuid-c');
    expect(enqueueSpy).toHaveBeenCalledWith('uuid-c', 'ship the release', false, {
      durable: true,
      prepend: true,
    });
    expect(enqueueSpy.mock.calls.some((call) => call[1] === '/compact')).toBe(false);
  });

  it('restarts when the query cannot cancel survivors', async () => {
    const session = createAgentSession();
    const noCancelQuery = {
      async *[Symbol.asyncIterator]() {},
      interrupt: async () => ({ still_queued: ['uuid-n'] }),
      getContextUsage: async () => makeUsageResponse(),
      close: () => {},
    } as unknown as QueryLike;
    session.queryObject = noCancelQuery;
    const enqueueSpy = spyOn(session.messageQueue, 'enqueueWithId').mockResolvedValue(undefined);
    const restartSpy = spyOn(session.lifecycleManager, 'restart').mockResolvedValue(undefined);

    await session.midTurnContextBudgetCheck();

    expect(restartSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('replaces a cancelled still-queued internal compaction with a fresh one', async () => {
    const session = createAgentSession();
    const harness = makeQuery();
    session.queryObject = harness.query;
    session.messageQueue.noteInternalCompactionSent({
      id: 'compact-uuid',
      content: '/compact',
      internal: true,
    } as never);
    expect(session.messageQueue.hasOutstandingInternalCompaction()).toBe(true);
    harness.setInterruptResult(async () => ({ still_queued: ['compact-uuid'] }));
    const enqueueSpy = spyOn(session.messageQueue, 'enqueueWithId').mockResolvedValue(undefined);

    await session.midTurnContextBudgetCheck();

    expect(harness.cancelMock).toHaveBeenCalledWith('compact-uuid');
    expect(enqueueSpy.mock.calls.some((call) => call[0] === 'compact-uuid')).toBe(false);
    const compactCall = enqueueSpy.mock.calls.find((call) => call[1] === '/compact');
    expect(compactCall).toBeDefined();
  });

  it('does not reprocess an in-time receipt when survivor processing outlasts the deadline', async () => {
    const session = createAgentSession();
    const harness = makeQuery();
    session.queryObject = harness.query;
    session.messageQueue.noteInternalCompactionSent({
      id: 'uuid-a',
      content: 'slow work a',
      internal: false,
    } as never);
    session.messageQueue.noteInternalCompactionSent({
      id: 'uuid-b',
      content: 'slow work b',
      internal: false,
    } as never);
    harness.setInterruptResult(async () => ({ still_queued: ['uuid-a', 'uuid-b'] }));
    harness.cancelMock.mockImplementation(async () => {
      await tick(3_000);
      return true;
    });
    const enqueueSpy = spyOn(session.messageQueue, 'enqueueWithId').mockResolvedValue(undefined);

    await session.midTurnContextBudgetCheck();
    for (let i = 0; i < 60; i += 1) {
      await tick(30);
    }

    expect(harness.cancelMock).toHaveBeenCalledTimes(2);
    expect(enqueueSpy.mock.calls.filter((call) => call[0] === 'uuid-a')).toHaveLength(1);
    expect(enqueueSpy.mock.calls.filter((call) => call[0] === 'uuid-b')).toHaveLength(1);
  }, 15_000);

  it('awaits a bounded query restart after an unconfirmed survivor cancellation', async () => {
    const session = createAgentSession();
    const harness = makeQuery();
    session.queryObject = harness.query;
    harness.setInterruptResult(async () => ({ still_queued: ['uuid-b'] }));
    harness.cancelMock.mockImplementation(async () => false);
    const enqueueSpy = spyOn(session.messageQueue, 'enqueueWithId').mockResolvedValue(undefined);
    let resolveRestart: () => void = () => {};
    const restartPromise = new Promise<void>((resolve) => {
      resolveRestart = resolve;
    });
    const restartSpy = spyOn(session.lifecycleManager, 'restart').mockImplementation(
      () => restartPromise
    );

    let settled = false;
    const check = session.midTurnContextBudgetCheck().then(() => {
      settled = true;
    });
    await tick(50);

    expect(restartSpy).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(enqueueSpy).not.toHaveBeenCalled();

    resolveRestart();
    await check;
    expect(settled).toBe(true);
  });

  it('processes survivors from an interrupt receipt that settles after the deadline', async () => {
    const session = createAgentSession();
    const harness = makeQuery();
    session.queryObject = harness.query;
    session.messageQueue.noteInternalCompactionSent({
      id: 'uuid-late',
      content: 'keep going',
      internal: false,
    } as never);
    harness.setInterruptResult(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ still_queued: ['uuid-late'] }), 5_150);
        })
    );
    const enqueueSpy = spyOn(session.messageQueue, 'enqueueWithId').mockResolvedValue(undefined);
    spyOn(session.lifecycleManager, 'restart').mockResolvedValue(undefined);

    await session.midTurnContextBudgetCheck();
    for (let i = 0; i < 50 && harness.cancelMock.mock.calls.length === 0; i += 1) {
      await tick(30);
    }

    expect(harness.cancelMock).toHaveBeenCalledTimes(1);
    expect(harness.cancelMock).toHaveBeenCalledWith('uuid-late');
    expect(enqueueSpy).toHaveBeenCalledWith('uuid-late', 'keep going', false, {
      durable: true,
      prepend: true,
    });
  }, 15_000);

  it('serializes concurrent mid-turn budget checks into a single interrupt', async () => {
    const session = createAgentSession();
    const harness = makeQuery();
    session.queryObject = harness.query;
    let interruptCalls = 0;
    harness.setInterruptResult(
      () =>
        new Promise((resolve) => {
          interruptCalls += 1;
          setTimeout(() => resolve({ still_queued: [] }), 30);
        })
    );
    const enqueueSpy = spyOn(session.messageQueue, 'enqueueWithId').mockResolvedValue(undefined);

    await Promise.all([session.midTurnContextBudgetCheck(), session.midTurnContextBudgetCheck()]);

    expect(interruptCalls).toBe(1);
    const compactCalls = enqueueSpy.mock.calls.filter((call) => call[1] === '/compact');
    expect(compactCalls).toHaveLength(1);
  });

  it('enqueues compaction when the interrupt resolves without a receipt', async () => {
    const session = createAgentSession();
    const harness = makeQuery();
    session.queryObject = harness.query;
    harness.setInterruptResult(async () => undefined);
    const enqueueSpy = spyOn(session.messageQueue, 'enqueueWithId').mockResolvedValue(undefined);

    await session.midTurnContextBudgetCheck();

    expect(harness.cancelMock).not.toHaveBeenCalled();
    const compactCall = enqueueSpy.mock.calls.find((call) => call[1] === '/compact');
    expect(compactCall).toBeDefined();
    expect(compactCall?.[2]).toBe(true);
    expect(compactCall?.[3]).toEqual({ durable: true, prepend: true });
  });

  it('keeps the pending resume armed when a timed-out interrupt later rejects', async () => {
    const session = createAgentSession();
    const harness = makeQuery();
    session.queryObject = harness.query;
    harness.setInterruptResult(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('interrupt failed late')), 5_150);
        })
    );
    const enqueueSpy = spyOn(session.messageQueue, 'enqueueWithId').mockResolvedValue(undefined);
    spyOn(session.lifecycleManager, 'restart').mockResolvedValue(undefined);

    await session.midTurnContextBudgetCheck();
    for (let i = 0; i < 50; i += 1) {
      await tick(30);
    }

    session.resumePendingWorkAfterCompaction();
    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Continue the task'),
      false,
      { durable: true }
    );
  }, 15_000);

  it('throttles the mid-turn usage refresh within the sampling window', async () => {
    const session = createAgentSession();
    const harness = makeQuery();
    session.queryObject = harness.query;
    harness.usageMock.mockImplementation(async () => ({
      ...makeUsageResponse(),
      totalTokens: 10_000,
      percentage: 5,
    }));

    await session.midTurnContextBudgetCheck();
    await session.midTurnContextBudgetCheck();

    expect(harness.usageMock).toHaveBeenCalledTimes(1);
  });

  it('skips the mid-turn check in turn-end-protected states', async () => {
    const setups: ((session: AgentSession) => unknown)[] = [
      (session) =>
        session.stateManager.setWaitingForInput({
          toolUseId: 'tool-waiting',
          questions: [],
          askedAt: Date.now(),
        }),
      (session) =>
        session.stateManager.setRateLimitCooldown({
          retryCount: 1,
          maxRetries: 3,
          retryAt: Date.now() + 60_000,
        }),
      (session) => {
        session.messageQueue.stop();
      },
    ];
    for (const setup of setups) {
      const session = createAgentSession();
      const harness = makeQuery();
      session.queryObject = harness.query;
      await setup(session);

      await session.midTurnContextBudgetCheck();

      expect(harness.usageMock).toHaveBeenCalledTimes(0);
      expect(harness.interruptMock).toHaveBeenCalledTimes(0);
    }
  });

  it('refreshes usage when the model changes inside the sampling window', async () => {
    const session = createAgentSession();
    const harness = makeQuery();
    session.queryObject = harness.query;
    harness.usageMock.mockImplementation(async () => ({
      ...makeUsageResponse(),
      totalTokens: 10_000,
      percentage: 5,
    }));

    await session.midTurnContextBudgetCheck();
    session.session.config.model = 'other-model';
    await session.midTurnContextBudgetCheck();

    expect(harness.usageMock).toHaveBeenCalledTimes(2);
  });

  it('retries the sampling window when a fetch declines or fails', async () => {
    const session = createAgentSession();
    const harness = makeQuery();
    session.queryObject = harness.query;
    harness.usageMock.mockImplementation(async () => ({
      ...makeUsageResponse(),
      totalTokens: 10_000,
      percentage: 5,
    }));

    await session.midTurnContextBudgetCheck();
    session.session.config.model = 'other-model';
    harness.usageMock.mockImplementation(async () => {
      throw new Error('busy');
    });
    await session.midTurnContextBudgetCheck();
    harness.usageMock.mockImplementation(async () => ({
      ...makeUsageResponse(),
      totalTokens: 10_000,
      percentage: 5,
    }));
    await session.midTurnContextBudgetCheck();

    expect(harness.usageMock).toHaveBeenCalledTimes(3);
  });

  it('drains the queue after the interrupt with compaction first', async () => {
    const session = createAgentSession();
    const harness = makeQuery();
    session.queryObject = harness.query;
    session.messageQueue.noteInternalCompactionSent({
      id: 'uuid-drain',
      content: 'drain survivor',
      internal: false,
    } as never);
    harness.setInterruptResult(async () => ({ still_queued: ['uuid-drain'] }));

    await session.midTurnContextBudgetCheck();

    const replay = session.messageQueue.messageGenerator(session.session.id);
    const order: string[] = [];
    for (let index = 0; index < 2; index++) {
      const yielded = await replay.next();
      order.push((yielded.value.message.message.content as Array<{ text?: string }>)[0].text ?? '');
      yielded.value.onSent();
      if (index === 0) {
        session.messageQueue.acknowledgeCompactionsAwaitingBoundary();
      }
    }
    expect(order).toEqual(['/compact', 'drain survivor']);
  });

  it('aborts the interrupt when the turn stops during the usage refresh', async () => {
    const session = createAgentSession();
    const harness = makeQuery();
    session.queryObject = harness.query;
    harness.usageMock.mockImplementation(async () => {
      await session.stateManager.setInterrupted();
      return makeUsageResponse();
    });
    const enqueueSpy = spyOn(session.messageQueue, 'enqueueWithId').mockResolvedValue(undefined);

    await session.midTurnContextBudgetCheck();

    expect(harness.interruptMock).toHaveBeenCalledTimes(0);
    expect(enqueueSpy).toHaveBeenCalledTimes(0);
  });

  it('recovers an evicted survivor from the durable message store', async () => {
    const session = createAgentSession();
    const harness = makeQuery();
    session.queryObject = harness.query;
    const retryMock = mock(() => null);
    (
      session.db as unknown as {
        getSDKMessageRepo: () => {
          getUserMessageContentByUuid: () => string | null;
          markDeliveryRetryableByUuid: typeof retryMock;
        };
      }
    ).getSDKMessageRepo = () => ({
      getUserMessageContentByUuid: () => 'db-recovered',
      markDeliveryRetryableByUuid: retryMock,
    });
    const enqueueSpy = spyOn(session.messageQueue, 'enqueueWithId').mockResolvedValue(undefined);
    harness.setInterruptResult(async () => ({ still_queued: ['uuid-lru-evicted'] }));

    await session.midTurnContextBudgetCheck();

    expect(enqueueSpy).toHaveBeenCalledWith('uuid-lru-evicted', 'db-recovered', false, {
      durable: true,
      prepend: true,
    });
    expect(retryMock).toHaveBeenCalledWith(expect.any(String), 'uuid-lru-evicted');
  });

  it('rebuilds evicted batched survivor content from the active batch', async () => {
    const session = createAgentSession();
    const harness = makeQuery();
    session.queryObject = harness.query;
    (
      session.db as unknown as {
        getSDKMessageRepo: () => {
          getUserMessageContentByUuid: (sessionId: string, uuid: string) => string | null;
          markDeliveryRetryableByUuid: () => string | null;
          getDeliveryContent: (
            sessionId: string,
            uuid: string
          ) => { content: string; sendStatus: string } | null;
        };
      }
    ).getSDKMessageRepo = () => ({
      getUserMessageContentByUuid: (_sessionId: string, uuid: string) =>
        uuid === 'uuid-batch-1' ? 'kickoff-text' : null,
      markDeliveryRetryableByUuid: () => null,
      getDeliveryContent: (_sessionId: string, uuid: string) =>
        uuid === 'uuid-batch-1'
          ? { content: 'kickoff-text', sendStatus: 'submitted' }
          : { content: 'member-text', sendStatus: 'submitted' },
    });
    (
      session.db as unknown as {
        getJobQueueRepo: () => { getActiveDeliveryBatchUuids: () => string[] | null };
      }
    ).getJobQueueRepo = () => ({
      getActiveDeliveryBatchUuids: () => ['uuid-batch-1', 'uuid-batch-2'],
    });
    const enqueueSpy = spyOn(session.messageQueue, 'enqueueWithId').mockResolvedValue(undefined);
    harness.setInterruptResult(async () => ({ still_queued: ['uuid-batch-1'] }));

    await session.midTurnContextBudgetCheck();

    expect(enqueueSpy).toHaveBeenCalledWith(
      'uuid-batch-1',
      buildBatchedDeliveryContent(['kickoff-text', 'member-text']),
      false,
      { durable: true, prepend: true }
    );
  });
});

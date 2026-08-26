import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { MessageHub, Session } from '@hyperneo/shared';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
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
    subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
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
    getConsumedUserMessagesAfterLatestInit: mock(() => []),
  } as unknown as Database;

  return new AgentSession(
    mockSession,
    mockDb,
    { event: mock(() => {}) } as MessageHub,
    makeEventBus(),
    mock(async () => 'test-api-key')
  );
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
}

function makeQuery(): QueryHarness {
  const cancelMock = mock(async (_uuid: string) => true);
  const usageMock = mock(async () => makeUsageResponse());
  const state: { interruptImpl: () => Promise<{ still_queued: string[] } | undefined> } = {
    interruptImpl: async () => ({ still_queued: [] }),
  };
  const query = {
    async *[Symbol.asyncIterator]() {},
    interrupt: () => state.interruptImpl(),
    cancelAsyncMessage: (uuid: string) => cancelMock(uuid),
    getContextUsage: () => usageMock(),
    close: () => {},
  } as unknown as QueryLike;
  return {
    query,
    setInterruptResult: (impl) => {
      state.interruptImpl = impl;
    },
    cancelMock,
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
    });
  });

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

    await session.midTurnContextBudgetCheck();
    for (let i = 0; i < 50 && harness.cancelMock.mock.calls.length === 0; i += 1) {
      await tick(30);
    }

    expect(harness.cancelMock).toHaveBeenCalledTimes(1);
    expect(harness.cancelMock).toHaveBeenCalledWith('uuid-late');
    expect(enqueueSpy).toHaveBeenCalledWith('uuid-late', 'keep going', false, {
      durable: true,
    });
  }, 15_000);
});

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { ContextInfo, MessageHub, ModelInfo, Session } from '@hyperneo/shared';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
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

function createAgentSession(model: string): AgentSession {
  const mockSession: Session = {
    id: `switch-budget-${Math.random()}`,
    title: 'Model switch budget session',
    workspacePath: '/test/workspace',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: {
      model,
      provider: 'openrouter',
      maxTokens: 8192,
      temperature: 1.0,
    },
    metadata: {},
  } as Session;

  const mockDb = {
    getSession: mock(() => mockSession),
    updateSession: mock(() => {}),
    getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
    getSDKMessageRepo: mock(() => ({
      getUserMessageContentByUuid: mock(() => null),
      markDeliveryRetryableByUuid: mock(() => null),
    })),
  } as unknown as Database;

  return new AgentSession(
    mockSession,
    mockDb,
    { event: mock(() => {}) } as MessageHub,
    makeEventBus(),
    mock(async () => 'test-api-key')
  );
}

function restoreTrackerInfo(totalUsed: number, totalCapacity: number): ContextInfo {
  return {
    model: 'old-model',
    totalUsed,
    totalCapacity,
    percentUsed: Math.floor((totalUsed / totalCapacity) * 100),
    breakdown: {},
    isAutoCompactEnabled: false,
  };
}

function cacheModelsWithWindow(contextWindow: number): void {
  setModelsCache(
    new Map([
      [
        'global',
        [
          {
            id: 'switched-model',
            name: 'Switched Model',
            provider: 'openrouter',
            contextWindow,
          } as unknown as ModelInfo,
        ],
      ],
    ])
  );
}

describe('AgentSession model-switch context budget re-evaluation', () => {
  beforeEach(() => {
    setModelsCache(new Map());
  });

  afterEach(() => {
    setModelsCache(new Map());
    resetProviderRegistry();
  });

  it('enqueues a dormant compaction while the queue is stopped after a switch to a tighter window', async () => {
    cacheModelsWithWindow(1_000_000);
    const session = createAgentSession('switched-model');
    session.contextTracker.restoreFromMetadata(restoreTrackerInfo(950_000, 2_000_000));
    const enqueueSpy = spyOn(session.messageQueue, 'enqueue');

    await session.reevaluateContextBudgetAfterModelSwitch();

    expect(enqueueSpy).toHaveBeenCalledWith('/compact', true, {
      durable: true,
      prepend: true,
    });
    expect(session.messageQueue.hasQueuedInternalCompaction()).toBe(true);
  });

  it('skips compaction when the new window leaves headroom', async () => {
    cacheModelsWithWindow(2_000_000);
    const session = createAgentSession('switched-model');
    session.contextTracker.restoreFromMetadata(restoreTrackerInfo(950_000, 1_000_000));
    const enqueueSpy = spyOn(session.messageQueue, 'enqueue');

    await session.reevaluateContextBudgetAfterModelSwitch();

    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('revokes a queued compaction computed for the previous window before re-deciding', async () => {
    cacheModelsWithWindow(1_000_000);
    const session = createAgentSession('switched-model');
    session.contextTracker.restoreFromMetadata(restoreTrackerInfo(950_000, 1_000_000));
    session.contextTracker.markCompactionTriggered(900_000);
    const cooldownClearSpy = spyOn(session.contextTracker, 'clearCompactionCooldown');
    const enqueueSpy = spyOn(session.messageQueue, 'enqueue');
    void session.messageQueue.admitWithId('stale-compact', '/compact', true, { durable: true });
    expect(session.messageQueue.hasQueuedInternalCompaction()).toBe(true);

    await session.reevaluateContextBudgetAfterModelSwitch();

    expect(cooldownClearSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith('/compact', true, {
      durable: true,
      prepend: true,
    });
  });

  it('does not enqueue a second compaction while a delivered one awaits its boundary', async () => {
    cacheModelsWithWindow(1_000_000);
    const session = createAgentSession('switched-model');
    session.contextTracker.restoreFromMetadata(restoreTrackerInfo(950_000, 1_000_000));
    session.messageQueue.noteInternalCompactionSent({
      id: 'delivered-compact',
      content: '/compact',
      internal: true,
    } as never);
    expect(session.messageQueue.hasCompactionsAwaitingBoundary()).toBe(true);
    const enqueueSpy = spyOn(session.messageQueue, 'enqueue');

    await session.reevaluateContextBudgetAfterModelSwitch();

    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});

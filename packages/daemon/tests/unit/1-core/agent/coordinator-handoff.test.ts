import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Provider, MessageHub } from '@hyperneo/shared';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import {
  decideCoordinatorHandoff,
  gateHandoffBinding,
  gateHandoffOwnership,
  gateHandoffAvailability,
  gateHandoffPending,
} from '../../../../src/lib/agent/coordinator-handoff';
import {
  withContextClearBoundary,
  withSessionLock,
} from '../../../../src/lib/agent/message-delivery';
import { resetSdkStartupGateForTests } from '../../../../src/lib/agent/sdk-startup-gate';
import { initializeProviders } from '../../../../src/lib/providers/factory';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository';
import type { Database } from '../../../../src/storage/database';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('coordinator handoff admission', () => {
  const binding: NeoBinding = { sessionId: 'neo:test', concernId: 'club', kind: 'concern' };
  const ownership = {
    generation: 1,
    currentGeneration: 1,
    interruptEpoch: 0,
    currentInterruptEpoch: 0,
    queryActive: false,
  };
  const availability = {
    sessionStatus: 'active',
    queryMode: undefined,
    provider: undefined,
    processingStatus: 'idle',
    cleaningUp: false,
    waiting: false,
    recovering: false,
  };
  it.each(['neo', 'concern', 'worker'] as const)('checks the %s binding', (kind) => {
    const candidate = { ...binding, kind };
    expect(gateHandoffBinding(candidate)).toEqual(
      kind === 'worker' ? { reason: 'not_coordinator' } : { value: candidate }
    );
  });
  it.each([{ currentGeneration: 2 }, { currentInterruptEpoch: 1 }, { queryActive: true }])(
    'rejects superseded ownership %j',
    (changed) => {
      expect(gateHandoffOwnership(binding, { ...ownership, ...changed })).toEqual({
        reason: 'superseded',
      });
    }
  );
  it.each([
    { sessionStatus: undefined },
    { sessionStatus: 'archived' },
    { sessionStatus: 'ended' },
    { queryMode: 'manual' },
    { provider: 'acp' },
    { processingStatus: 'processing' },
    { processingStatus: 'waiting_for_input' },
    { processingStatus: 'rate_limit_cooldown' },
    { processingStatus: 'interrupted' },
    { cleaningUp: true },
    { waiting: true },
    { recovering: true },
  ])('rejects unavailable lifecycle %j', (changed) => {
    expect(gateHandoffAvailability(binding, { ...availability, ...changed })).toEqual({
      reason: 'unavailable',
    });
  });
  it.each(['idle', 'queued'])('admits a %s successor synchronously', (processingStatus) => {
    expect(gateHandoffOwnership(binding, ownership)).toEqual({ value: binding });
    expect(gateHandoffAvailability(binding, { ...availability, processingStatus })).toEqual({
      value: binding,
    });
    expect(gateHandoffPending(binding, true)).toEqual({ value: binding });
    expect(decideCoordinatorHandoff(binding, ownership, availability, true)).toEqual(binding);
  });
  it('pins gate precedence and the empty-queue exit', () => {
    const stale = { ...ownership, currentGeneration: 2 };
    const stopped = { ...availability, cleaningUp: true };
    expect(gateHandoffBinding(null)).toEqual({ reason: 'not_coordinator' });
    expect(gateHandoffPending(binding, false)).toEqual({ reason: 'no_successor' });
    expect(decideCoordinatorHandoff(null, stale, stopped, false)).toBe('not_coordinator');
    expect(decideCoordinatorHandoff(binding, stale, stopped, false)).toBe('superseded');
    expect(decideCoordinatorHandoff(binding, ownership, stopped, false)).toBe('unavailable');
    expect(decideCoordinatorHandoff(binding, ownership, availability, false)).toBe('no_successor');
  });
});

describe.each(['neo', 'concern'] as const)('AgentSession %s coordinator handoff', (kind) => {
  const providerId = 'custom:neo-handoff-unit';
  let db: Database;
  let agent: AgentSession;
  let firstReady: ReturnType<typeof deferred>;
  let finishFirst: ReturnType<typeof deferred>;
  let secondReady: ReturnType<typeof deferred>;
  let finishSecond: ReturnType<typeof deferred>;
  let received: string[];
  let active: number;
  let peak: number;

  beforeEach(async () => {
    resetSdkStartupGateForTests();
    db = await createTestDb();
    const session = createTestSession(`neo:handoff-${kind}`);
    session.workspacePath = null;
    session.config = { model: 'unit', provider: providerId };
    db.createSession(session);
    const neo = new NeoRepository(db.getDatabase());
    if (kind === 'concern')
      neo.saveConcern({ id: 'club', title: 'Club', summary: '', context: '' }, 0);
    neo.reserveBinding({
      sessionId: session.id,
      concernId: kind === 'concern' ? 'club' : null,
      kind,
    });
    initializeProviders().register({
      id: providerId,
      displayName: 'Neo handoff unit',
      isAvailable: async () => true,
      getAuthStatus: async () => ({ isAuthenticated: true, method: 'api_key' }),
      buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
    } as unknown as Provider);
    agent = new AgentSession(
      session,
      db,
      { event: mock(() => {}) } as unknown as MessageHub,
      await createTestInternalEventBus(),
      async () => 'test-key',
      undefined,
      undefined,
      { autoReplayPendingMessages: false }
    );
    spyOn(agent.optionsBuilder, 'build').mockResolvedValue({ model: 'unit' });
    spyOn(agent, 'onSDKMessage').mockResolvedValue(undefined);
    firstReady = deferred();
    finishFirst = deferred();
    secondReady = deferred();
    finishSecond = deferred();
    received = [];
    active = 0;
    peak = 0;
    (query as unknown as ReturnType<typeof mock>).mockImplementation(
      (args: Parameters<typeof query>[0]) => ({
        close: () => {},
        interrupt: async () => {},
        [Symbol.asyncIterator]: async function* () {
          active++;
          peak = Math.max(peak, active);
          try {
            const feed = (args.prompt as AsyncIterable<{ uuid: string }>)[Symbol.asyncIterator]();
            const first = await feed.next();
            received.push(first.value!.uuid);
            expect((await feed.next()).done).toBe(true);
            const initial = received.length === 1;
            (initial ? firstReady : secondReady).resolve();
            await (initial ? finishFirst : finishSecond).promise;
            yield { type: 'result', subtype: 'success', uuid: crypto.randomUUID() };
          } finally {
            active--;
          }
        },
      })
    );
  });

  afterEach(async () => {
    agent.setCleaningUp(true);
    finishFirst.resolve();
    finishSecond.resolve();
    await agent.queryPromise;
    agent.messageQueue.clear();
    agent.messageQueue.stop();
    agent.cleanupEventSubscriptions();
    db.getDatabase().close();
    initializeProviders().unregister(providerId);
    (query as unknown as ReturnType<typeof mock>).mockReset();
  });

  function deliver(uuid: string) {
    db.saveUserMessage(
      agent.session.id,
      {
        type: 'user',
        uuid,
        session_id: agent.session.id,
        parent_tool_use_id: null,
        inputKind: 'human',
        message: { role: 'user', content: uuid },
      },
      'enqueued'
    );
    const drive = agent.driveDeliveryTurn(uuid, uuid);
    void drive.catch(() => {});
    return drive;
  }

  async function admitSuccessor() {
    const first = deliver('ask-A');
    await expect.poll(() => received, { timeout: 1500 }).toEqual(['ask-A']);
    await firstReady.promise;
    await first;
    const second = deliver('ask-B');
    await withSessionLock(agent.session.id, async () => {});
    expect(agent.messageQueue.hasPendingOrInFlight('ask-B')).toBe(true);
    return { second, firstQuery: agent.queryPromise };
  }

  it('starts an already-admitted successor on settlement without timeout or another start call', async () => {
    const errors = spyOn(agent.errorManager, 'handleError').mockResolvedValue(undefined);
    const { second, firstQuery } = await admitSuccessor();
    finishFirst.resolve();
    await firstQuery;
    await expect.poll(() => received, { timeout: 1500 }).toEqual(['ask-A', 'ask-B']);
    await secondReady.promise;
    expect(received).toEqual(['ask-A', 'ask-B']);
    expect(peak).toBe(1);
    expect(new NeoRepository(db.getDatabase()).listConcerns()).toHaveLength(kind === 'neo' ? 0 : 1);
    expect(errors).not.toHaveBeenCalled();
    expect(agent.getQueryGeneration()).toBe(2);
    await expect(second).resolves.toEqual({ outcome: 'completed' });
    expect(db.getMessageByStatusAndUuid(agent.session.id, 'consumed', 'ask-B')).toBeTruthy();
    const nextQuery = agent.queryPromise;
    finishSecond.resolve();
    await nextQuery;
    expect(agent.messageQueue.size()).toBe(0);
  });

  it('keeps a successor admitted through a turn longer than the consumption timeout', async () => {
    const previous = process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
    process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = '50';
    try {
      const { second, firstQuery } = await admitSuccessor();
      let settled = false;
      void second.then(
        () => (settled = true),
        () => (settled = true)
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(settled).toBe(false);
      expect(agent.messageQueue.hasPendingOrInFlight('ask-B')).toBe(true);
      finishFirst.resolve();
      await firstQuery;
      await expect(second).resolves.toEqual({ outcome: 'completed' });
      expect(received).toEqual(['ask-A', 'ask-B']);
      const nextQuery = agent.queryPromise;
      finishSecond.resolve();
      await nextQuery;
    } finally {
      if (previous === undefined) delete process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
      else process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = previous;
    }
  });

  it.each(['manual', 'archived', 'interrupt', 'cleanup', 'waiting', 'recovery', 'stale'] as const)(
    'does not hand off while %s',
    async (condition) => {
      const { firstQuery } = await admitSuccessor();
      const stop = {
        manual: () => (agent.session.config.queryMode = 'manual'),
        archived: () => db.updateSession(agent.session.id, { status: 'archived' }),
        interrupt: () => agent.messageQueue.noteUserInterrupt(),
        cleanup: () => agent.setCleaningUp(true),
        waiting: () => spyOn(agent, 'isWaitingForInput').mockReturnValue(true),
        recovery: () => spyOn(agent, 'isLimitRecoveryPending').mockReturnValue(true),
        stale: () => agent.incrementQueryGeneration(),
      };
      stop[condition]();
      finishFirst.resolve();
      await firstQuery;
      await withSessionLock(agent.session.id, async () => {});
      expect(received).toEqual(['ask-A']);
      expect(query).toHaveBeenCalledTimes(1);
      expect(agent.messageQueue.hasPendingOrInFlight('ask-B')).toBe(true);
    }
  );

  it('rechecks ownership after asynchronous lifecycle preparation', async () => {
    const { firstQuery } = await admitSuccessor();
    const preparing = deferred();
    const prepared = deferred();
    spyOn(agent, 'clearModelsCache').mockImplementation(async () => {
      preparing.resolve();
      await prepared.promise;
    });
    finishFirst.resolve();
    await firstQuery;
    await preparing.promise;
    agent.messageQueue.noteUserInterrupt();
    prepared.resolve();
    await withSessionLock(agent.session.id, async () => {});
    expect(query).toHaveBeenCalledTimes(1);
    expect(received).toEqual(['ask-A']);
    expect(agent.getQueryGeneration()).toBe(1);
  });

  it('hands off only after an active context-clear boundary releases', async () => {
    const { firstQuery, second } = await admitSuccessor();
    const release = deferred();
    const clearing = withContextClearBoundary(agent.session.id, () => release.promise);
    try {
      finishFirst.resolve();
      await firstQuery;
      await withSessionLock(agent.session.id, async () => {});
      expect(query).toHaveBeenCalledTimes(1);
      expect(received).toEqual(['ask-A']);
    } finally {
      release.resolve();
      await clearing;
    }
    await secondReady.promise;
    await expect(second).resolves.toEqual({ outcome: 'completed' });
    expect(received).toEqual(['ask-A', 'ask-B']);
    expect(peak).toBe(1);
  });
});

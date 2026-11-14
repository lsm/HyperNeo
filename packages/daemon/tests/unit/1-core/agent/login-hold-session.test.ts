import { describe, expect, it, mock } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import type { ProviderRefreshClock } from '../../../../src/lib/credentials/oauth-refresh-scheduler';
import type { RefreshNowOutcome } from '../../../../src/lib/credentials/oauth-refresh-scheduler';
import { clearProviderFailure } from '../../../../src/lib/providers/provider-failure-store';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database';

interface Harness {
  agent: AgentSession;
  clocks: Map<string, ProviderRefreshClock>;
  setNeedsLogin(providerId: string, at: number | null): void;
  writes: Array<(providerId: string) => void>;
  resume: ReturnType<typeof mock>;
  started: ReturnType<typeof mock>;
  deliver(
    uuid?: string,
    content?: string
  ): Promise<Awaited<ReturnType<AgentSession['driveDeliveryTurn']>>>;
  deliverWhileQueued(
    uuid: string,
    content: string
  ): Promise<Awaited<ReturnType<AgentSession['driveDeliveryTurn']>>>;
}

async function harness(
  options: { processingState?: string; needsLoginAt?: number } = {}
): Promise<Harness> {
  const db = await createTestDb();
  const session = createTestSession('login-hold');
  session.config.provider = 'anthropic';
  await db.createSession(session);
  clearProviderFailure('anthropic');
  if (options.processingState)
    await db.updateSession(session.id, { processingState: options.processingState });
  const saved = (await db.getSession(session.id)) ?? session;

  const clocks = new Map<string, ProviderRefreshClock>();
  const needsLogin = new Map<string, number | null>();
  const writes: Array<(providerId: string) => void> = [];
  let nextOutcome: RefreshNowOutcome = 'transient';
  let refreshes = 0;
  if (options.needsLoginAt !== undefined) needsLogin.set('anthropic', options.needsLoginAt);

  const agent = new AgentSession(
    saved,
    db,
    new MessageHub(),
    await createTestInternalEventBus(),
    mock(async () => 'test-api-key'),
    undefined,
    undefined,
    undefined,
    undefined,
    {
      autoReplayPendingMessages: false,
      loginRecovery: {
        refresh: async (providerId) => {
          refreshes += 1;
          clocks.set(providerId, {
            nextRefreshAt: Date.now() + 60_000,
            attempt: (clocks.get(providerId)?.attempt ?? 0) + 1,
            lastOutcome: nextOutcome,
          });
          return nextOutcome;
        },
        refreshState: (providerId) =>
          clocks.get(providerId) ?? { nextRefreshAt: 0, attempt: 0, lastOutcome: 'none' },
        needsLoginAt: (providerId) => needsLogin.get(providerId) ?? null,
        setNeedsLogin: (providerId, at) => needsLogin.set(providerId, at),
        onCredentialsWritten: (callback) => {
          writes.push(callback);
          return () => {};
        },
      },
    }
  );

  const resume = mock(async () => 'started');
  const started = mock(async () => 'started');
  (agent as unknown as Record<string, unknown>).lifecycleManager = {
    ensureQueryStarted: started,
    startQueryAndEnqueue: resume,
    executeDeferredRestartIfPending: mock(async () => {}),
    cleanup: mock(async () => {}),
  };
  agent.queryPromise = new Promise<void>(() => {});

  const repo = db.getSDKMessageRepo();
  repo.saveUserMessage(
    session.id,
    {
      type: 'user',
      uuid: 'human-login',
      inputKind: 'human',
      message: { role: 'user', content: 'do the thing' },
    } as unknown as SDKMessage,
    'enqueued'
  );

  const deliver = async (uuid = 'human-login', content = 'do the thing') => {
    agent.messageQueue.start();
    const generator = agent.messageQueue.messageGenerator(session.id, {
      suppressPreYieldCallback: false,
    });
    const turn = agent.driveDeliveryTurn(uuid, content, null, false, () => true);
    const next = await generator.next();
    next.value?.onSent();
    const outcome = await turn;
    await generator.return?.(undefined);
    agent.messageQueue.stop();
    return outcome;
  };

  const deliverWhileQueued = async (uuid: string, content: string) => {
    agent.messageQueue.start();
    try {
      return await agent.driveDeliveryTurn(uuid, content, null, false, () => true);
    } finally {
      agent.messageQueue.stop();
    }
  };

  return {
    agent,
    clocks,
    setNeedsLogin: (providerId, at) => needsLogin.set(providerId, at),
    writes,
    resume,
    started,
    deliver,
    deliverWhileQueued,
  };
}

describe('login hold', () => {
  it('holds before calling the model when a restart left needs_login_at set', async () => {
    const h = await harness();
    h.setNeedsLogin('anthropic', Date.now());
    const outcome = await h.agent.driveDeliveryTurn(
      'human-login',
      'do the thing',
      null,
      false,
      () => true
    );
    expect(outcome).toMatchObject({ outcome: 'blocked' });
    expect(h.agent.isLoginHeld()).toBe(true);
    expect(h.agent.getProcessingState()).toMatchObject({
      status: 'rate_limit_cooldown',
      reason: 'login',
    });
    await h.agent.cleanup();
  });

  it('a held session starts no query for queued or new messages', async () => {
    const h = await harness();
    h.setNeedsLogin('anthropic', Date.now());
    await h.agent.driveDeliveryTurn('human-login', 'do the thing', null, false, () => true);
    expect(h.agent.isLoginHeld()).toBe(true);
    const heldState = h.agent.getProcessingState();

    for (const [uuid, content] of [
      ['queued-1', 'first queued ask'],
      ['queued-2', 'second queued ask'],
    ])
      expect(await h.deliverWhileQueued(uuid, content)).toMatchObject({ outcome: 'blocked' });

    expect(h.started).toHaveBeenCalledTimes(0);
    expect(h.agent.isLoginHeld()).toBe(true);
    expect(h.agent.getProcessingState()).toEqual(heldState);
    await h.agent.cleanup();
  });

  it('a transient login hold blocks new deliveries while no sign-in is needed', async () => {
    const h = await harness();
    h.setNeedsLogin('anthropic', null);
    const plan = await h.agent.onLoginRejected({ uuid: 'human-login', content: 'do the thing' });
    expect(plan).toBe('refresh_pending');
    expect(h.agent.isLoginHeld()).toBe(true);

    expect(await h.deliverWhileQueued('queued-1', 'a later ask')).toMatchObject({
      outcome: 'blocked',
    });

    expect(h.started).toHaveBeenCalledTimes(0);
    await h.agent.cleanup();
  });

  it('does not sign in when the provider is merely unhealthy', async () => {
    const h = await harness();
    h.setNeedsLogin('anthropic', null);
    const admitted = await h.deliver();
    expect(admitted.outcome).toBe('completed');
    expect(h.agent.isLoginHeld()).toBe(false);
    expect(h.agent.getProcessingState().status).not.toBe('rate_limit_cooldown');
    await h.agent.cleanup();
  });

  it('a credential write wakes a held session while a health-only change leaves it held', async () => {
    const h = await harness();
    h.setNeedsLogin('anthropic', Date.now());
    await h.agent.driveDeliveryTurn('human-login', 'do the thing', null, false, () => true);
    expect(h.agent.isLoginHeld()).toBe(true);

    for (const listener of h.writes) listener('glm');
    await new Promise((done) => setTimeout(done, 0));
    expect(h.agent.isLoginHeld()).toBe(true);
    expect(h.resume).toHaveBeenCalledTimes(0);

    h.setNeedsLogin('anthropic', null);
    h.clocks.delete('anthropic');
    for (const listener of h.writes) listener('anthropic');
    await new Promise((done) => setTimeout(done, 0));
    await new Promise((done) => setTimeout(done, 0));

    expect(h.agent.isLoginHeld()).toBe(false);
    expect(h.resume).toHaveBeenCalledTimes(1);
    await h.agent.cleanup();
  });

  it('a restart restores a saved login hold and a credential write resumes it', async () => {
    const h = await harness({
      processingState: JSON.stringify({
        status: 'rate_limit_cooldown',
        retryCount: 0,
        maxRetries: 0,
        retryAt: Date.now() + 60_000,
        reason: 'login',
        messageId: 'human-login',
        heldPrompt: { uuid: 'human-login', content: 'do the thing' },
      }),
      needsLoginAt: Date.now(),
    });

    expect(h.agent.isLoginHeld()).toBe(true);
    expect(h.agent.getProcessingState()).toMatchObject({
      status: 'rate_limit_cooldown',
      reason: 'login',
    });
    expect(h.started).toHaveBeenCalledTimes(0);

    h.setNeedsLogin('anthropic', null);
    h.clocks.delete('anthropic');
    for (const listener of h.writes) listener('anthropic');
    await new Promise((done) => setTimeout(done, 0));
    await new Promise((done) => setTimeout(done, 0));

    expect(h.agent.isLoginHeld()).toBe(false);
    expect(h.resume).toHaveBeenCalledTimes(1);
    expect(h.resume).toHaveBeenCalledWith('human-login', 'do the thing', undefined, {
      prepend: true,
    });
    await h.agent.cleanup();
  });

  it('a saved login hold does not come back as a usage-limit cooldown', async () => {
    const h = await harness({
      processingState: JSON.stringify({
        status: 'rate_limit_cooldown',
        retryCount: 2,
        maxRetries: 3,
        retryAt: Date.now() + 60_000,
        reason: 'login',
        messageId: 'human-login',
        heldPrompt: { uuid: 'human-login', content: 'do the thing' },
      }),
      needsLoginAt: Date.now(),
    });

    const state = h.agent.getProcessingState();
    expect(state).toMatchObject({ status: 'rate_limit_cooldown', reason: 'login' });
    expect(state).not.toHaveProperty('retryCount', 2);
    await h.agent.cleanup();
  });
});

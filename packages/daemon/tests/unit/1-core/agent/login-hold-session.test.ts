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
  deliver(): Promise<Awaited<ReturnType<AgentSession['driveDeliveryTurn']>>>;
}

async function harness(): Promise<Harness> {
  const db = await createTestDb();
  const session = createTestSession('login-hold');
  session.config.provider = 'anthropic';
  await db.createSession(session);
  clearProviderFailure('anthropic');

  const clocks = new Map<string, ProviderRefreshClock>();
  const needsLogin = new Map<string, number | null>();
  const writes: Array<(providerId: string) => void> = [];
  let nextOutcome: RefreshNowOutcome = 'transient';
  let refreshes = 0;

  const agent = new AgentSession(
    session,
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
  (agent as unknown as Record<string, unknown>).lifecycleManager = {
    ensureQueryStarted: mock(async () => 'started'),
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

  const deliver = async () => {
    agent.messageQueue.start();
    const generator = agent.messageQueue.messageGenerator(session.id, {
      suppressPreYieldCallback: false,
    });
    const turn = agent.driveDeliveryTurn('human-login', 'do the thing', null, false, () => true);
    const next = await generator.next();
    next.value?.onSent();
    const outcome = await turn;
    await generator.return?.(undefined);
    agent.messageQueue.stop();
    return outcome;
  };

  return {
    agent,
    clocks,
    setNeedsLogin: (providerId, at) => needsLogin.set(providerId, at),
    writes,
    resume,
    deliver,
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
});

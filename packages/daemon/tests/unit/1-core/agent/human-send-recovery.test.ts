import { describe, expect, test } from 'bun:test';
import {
  createHumanSendRecovery,
  HUMAN_SEND_GAVE_UP_NOTICE,
  HUMAN_SEND_RESEND_LIMIT,
  type HumanSendFacts,
  type HumanSendSession,
  isSessionAlive,
  planSilentSend,
  runHumanSendRecovery,
} from '../../../../src/lib/agent/human-send-recovery';

const facts = (over: Partial<HumanSendFacts> = {}): HumanSendFacts => ({
  status: 'idle',
  held: false,
  openTools: 0,
  lastActivityAt: 0,
  now: 100_000,
  silenceMs: 60_000,
  ...over,
});

describe('isSessionAlive', () => {
  test('allows only states that can answer', () => {
    expect(isSessionAlive(facts())).toBe(true);
    expect(isSessionAlive(facts({ status: 'waiting_for_input', held: true }))).toBe(true);
    expect(isSessionAlive(facts({ status: 'processing', lastActivityAt: 50_000 }))).toBe(true);
    expect(isSessionAlive(facts({ status: 'processing', openTools: 1 }))).toBe(true);
  });

  test('treats everything else as stuck, including states nobody listed', () => {
    expect(isSessionAlive(facts({ status: 'processing', lastActivityAt: 40_000 }))).toBe(false);
    expect(isSessionAlive(facts({ status: 'queued', lastActivityAt: 40_000 }))).toBe(false);
    expect(isSessionAlive(facts({ status: 'rate_limit_cooldown' }))).toBe(false);
    expect(isSessionAlive(facts({ status: 'interrupted' }))).toBe(false);
    expect(isSessionAlive(facts({ held: true }))).toBe(false);
    expect(isSessionAlive(facts({ status: 'processing', openTools: 1, held: true }))).toBe(false);
    expect(isSessionAlive(facts({ status: 'future' as HumanSendFacts['status'] }))).toBe(false);
  });
});

describe('planSilentSend', () => {
  const silent = { status: 'processing' as const, lastOutputAt: 5, sentAt: 10, resends: 0 };

  test('resends a swallowed message, then says so plainly', () => {
    expect(planSilentSend(silent)).toBe('resend');
    expect(planSilentSend({ ...silent, resends: HUMAN_SEND_RESEND_LIMIT })).toBe('give_up');
  });

  test('leaves a turn that answered or ended alone', () => {
    expect(planSilentSend({ ...silent, lastOutputAt: 11 })).toBe('answered');
    expect(planSilentSend({ ...silent, lastOutputAt: 10 })).toBe('resend');
    expect(planSilentSend({ ...silent, status: 'idle' })).toBe('answered');
    expect(planSilentSend({ ...silent, status: 'interrupted' })).toBe('answered');
  });
});

describe('runHumanSendRecovery', () => {
  function effects(alive: boolean, reachable: boolean, over: Partial<HumanSendFacts> = {}) {
    const calls: string[] = [];
    const step = (name: string) => async () => {
      calls.push(name);
    };
    return {
      calls,
      effects: {
        facts: async () => facts(alive ? { status: 'waiting_for_input' } : { held: true, ...over }),
        reachable: async () => {
          calls.push('probe');
          return reachable;
        },
        refresh: step('refresh'),
        rebuild: step('rebuild'),
        wake: step('wake'),
      },
    };
  }

  test('an alive session is not touched', async () => {
    const run = effects(true, true);
    expect(await runHumanSendRecovery(run.effects)).toBe('deliver');
    expect(run.calls).toEqual([]);
  });

  test('a stuck session takes the one recovery path in order', async () => {
    const run = effects(false, true);
    expect(await runHumanSendRecovery(run.effects)).toBe('recovered');
    expect(run.calls).toEqual(['probe', 'refresh', 'rebuild', 'wake']);
  });

  test('an unreachable provider waits without rebuilding', async () => {
    const run = effects(false, false);
    expect(await runHumanSendRecovery(run.effects)).toBe('wait');
    expect(run.calls).toEqual(['probe']);
  });
});

describe('human send recovery wiring', () => {
  function setup(session: Partial<HumanSendSession>) {
    const calls: string[] = [];
    const recovery = createHumanSendRecovery({
      getSession: async () =>
        ({
          humanSendFacts: async () => ({
            status: 'idle',
            held: true,
            openTools: 0,
            lastActivityAt: 0,
          }),
          lastSdkOutputAt: () => 0,
          providerId: () => 'anthropic',
          providerReachable: async () => true,
          holdForNetwork: async () => {
            calls.push('hold');
          },
          resetQuery: async () => {
            calls.push('rebuild');
            return { success: true };
          },
          showNotice: async (text: string) => {
            calls.push(text);
          },
          ...session,
        }) as HumanSendSession,
      refreshCredentials: async (providerId) => {
        calls.push(`refresh ${providerId}`);
      },
      wakeParked: async (sessionId) => {
        calls.push(`wake ${sessionId}`);
      },
      reopen: async (_sessionId, uuid) => {
        calls.push(`reopen ${uuid}`);
        return true;
      },
    });
    return { calls, recovery };
  }

  test('recovery refreshes the session provider and wakes that session', async () => {
    const { calls, recovery } = setup({});
    expect(await recovery.prepare('s')).toBe('recovered');
    expect(calls).toEqual(['refresh anthropic', 'rebuild', 'wake s']);
  });

  test('a failed rebuild does not pretend to have recovered', async () => {
    const { recovery } = setup({ resetQuery: async () => ({ success: false, error: 'no' }) });
    await expect(recovery.prepare('s')).rejects.toThrow('no');
  });

  test('an unreachable provider records the network hold', async () => {
    const { calls, recovery } = setup({ providerReachable: async () => false });
    expect(await recovery.prepare('s')).toBe('wait');
    expect(calls).toEqual(['hold']);
  });

  test('a silent send takes the recovery path even while the CLI still looks busy', async () => {
    process.env.HYPERNEO_HUMAN_SEND_SILENCE_MS = '5';
    const facts = async () => ({
      status: 'processing' as const,
      held: false,
      openTools: 0,
      lastActivityAt: Date.now() + 60_000,
    });
    const { calls, recovery } = setup({
      humanSendFacts: facts,
      providerReachable: async () => false,
    });
    try {
      expect(await recovery.prepare('s')).toBe('deliver');
      recovery.watch('s', 'm');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await recovery.prepare('s')).toBe('wait');
      expect(calls).toEqual(['reopen m', 'hold']);
      expect(await recovery.prepare('s')).toBe('deliver');
    } finally {
      recovery.stop();
      delete process.env.HYPERNEO_HUMAN_SEND_SILENCE_MS;
    }
  });

  test('a silent send is reopened, and gives up plainly at the limit', async () => {
    process.env.HYPERNEO_HUMAN_SEND_SILENCE_MS = '5';
    const { calls, recovery } = setup({
      humanSendFacts: async () => ({
        status: 'processing',
        held: false,
        openTools: 0,
        lastActivityAt: 0,
      }),
    });
    try {
      for (let sent = 0; sent <= HUMAN_SEND_RESEND_LIMIT; sent += 1) {
        recovery.watch('s', 'm');
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(calls.filter((call) => call === 'reopen m')).toHaveLength(HUMAN_SEND_RESEND_LIMIT);
      expect(calls.at(-1)).toBe(HUMAN_SEND_GAVE_UP_NOTICE);
    } finally {
      recovery.stop();
      delete process.env.HYPERNEO_HUMAN_SEND_SILENCE_MS;
    }
  });
});

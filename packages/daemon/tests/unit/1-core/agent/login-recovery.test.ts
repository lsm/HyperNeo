import { describe, expect, test } from 'bun:test';
import type { RefreshNowOutcome } from '../../../../src/lib/credentials/oauth-refresh-scheduler';
import {
  afterRefresh,
  createLoginRecovery,
  type LoginRecoveryFacts,
  LOGIN_HOLD_FIRST_DELAY_MS,
  loginHoldDelayMs,
  mayResume,
  runLoginRecovery,
} from '../../../../src/lib/agent/login-recovery';

const facts = (over: Partial<LoginRecoveryFacts> = {}): LoginRecoveryFacts => ({
  retried: false,
  needsLoginAt: null,
  refresh: { nextRefreshAt: 0, attempt: 0, lastOutcome: 'none' },
  ...over,
});

describe('afterRefresh', () => {
  test('retries the turn once when a refresh worked', () => {
    expect(afterRefresh('refreshed', false)).toBe('retry');
  });

  test('waits for the refresh clock after a transient failure', () => {
    expect(afterRefresh('transient', false)).toBe('refresh_pending');
  });

  test('asks for sign-in when the refresh was refused or could not run', () => {
    expect(afterRefresh('definitive', false)).toBe('sign_in');
    expect(afterRefresh('skipped', false)).toBe('sign_in');
  });

  test('asks for sign-in on any rejection after a refresh already ran', () => {
    const outcomes: RefreshNowOutcome[] = ['refreshed', 'transient', 'definitive', 'skipped'];
    for (const outcome of outcomes) expect(afterRefresh(outcome, true)).toBe('sign_in');
  });
});

describe('mayResume', () => {
  test('resumes when nothing asks for sign-in and no refresh is failing', () => {
    expect(mayResume(facts())).toBe(true);
    expect(
      mayResume(facts({ refresh: { nextRefreshAt: 0, attempt: 0, lastOutcome: 'refreshed' } }))
    ).toBe(true);
    expect(
      mayResume(facts({ refresh: { nextRefreshAt: 0, attempt: 0, lastOutcome: 'skipped' } }))
    ).toBe(true);
  });

  test('stays held while sign-in is needed or a refresh is still failing', () => {
    expect(mayResume(facts({ needsLoginAt: 1 }))).toBe(false);
    expect(
      mayResume(facts({ refresh: { nextRefreshAt: 1, attempt: 2, lastOutcome: 'transient' } }))
    ).toBe(false);
  });
});

describe('runLoginRecovery', () => {
  const effects = (
    refreshOutcome: RefreshNowOutcome,
    over: Partial<LoginRecoveryFacts> = {},
    refreshes: string[] = []
  ) => ({
    facts: async () => facts(over),
    refresh: async () => {
      refreshes.push('refresh');
      return refreshOutcome;
    },
  });

  test('refreshes once and retries the turn', async () => {
    const refreshes: string[] = [];
    expect(await runLoginRecovery(effects('refreshed', {}, refreshes))).toBe('retry');
    expect(refreshes).toHaveLength(1);
  });

  test('holds for the refresh clock after a transient failure', async () => {
    expect(await runLoginRecovery(effects('transient'))).toBe('refresh_pending');
  });

  test('holds for sign-in after a refused refresh', async () => {
    expect(await runLoginRecovery(effects('definitive'))).toBe('sign_in');
  });

  test('holds for sign-in when the provider cannot refresh at all', async () => {
    const refreshes: string[] = [];
    expect(await runLoginRecovery(effects('skipped', {}, refreshes))).toBe('sign_in');
    expect(refreshes).toHaveLength(1);
  });

  test('does not refresh again on a second rejection in the same turn', async () => {
    const refreshes: string[] = [];
    expect(await runLoginRecovery(effects('refreshed', { retried: true }, refreshes))).toBe(
      'sign_in'
    );
    expect(refreshes).toHaveLength(0);
  });
});

function recoveryDeps(
  overrides: {
    outcomes?: RefreshNowOutcome[];
    onSignIn?: (state: { needsLoginAt: number | null }) => void;
    onRefresh?: (write: () => Promise<boolean>) => void;
  } = {}
) {
  const outcomes = [...(overrides.outcomes ?? [])];
  const state: { needsLoginAt: number | null; lastOutcome: RefreshNowOutcome | 'none' } = {
    needsLoginAt: null,
    lastOutcome: 'none',
  };
  const timers: Array<() => void> = [];
  const held: number[] = [];
  const heldPrompts: Array<unknown> = [];
  const resumed: Array<unknown> = [];
  let recovery: { maybeResume(providerId: string): Promise<boolean> } | null = null;
  const deps = {
    facts: () => ({
      retried: false,
      needsLoginAt: state.needsLoginAt,
      refresh: { nextRefreshAt: 1_000, attempt: 0, lastOutcome: state.lastOutcome },
    }),
    refresh: async () => {
      overrides.onRefresh?.(() => recovery?.maybeResume('anthropic') ?? Promise.resolve(false));
      const outcome = outcomes.shift() ?? 'transient';
      state.lastOutcome = outcome;
      return outcome;
    },
    enterSignIn: () => {
      state.needsLoginAt = Date.now();
      overrides.onSignIn?.(state);
    },
    enterTransient: () => {},
    timer: {
      now: () => 0,
      schedule: (run: () => void) => {
        timers.push(run);
        return () => {};
      },
      hold: async (delayMs: number, prompt: unknown) => {
        held.push(delayMs);
        heldPrompts.push(prompt);
      },
      resume: async (prompt: unknown) => {
        resumed.push(prompt);
      },
      log: () => {},
    },
  };
  const attach = (value: { maybeResume(providerId: string): Promise<boolean> }) => {
    recovery = value;
  };
  return { deps, state, timers, held, heldPrompts, resumed, attach };
}

describe('createLoginRecovery', () => {
  test('a refused refresh marks the provider for sign-in and holds', async () => {
    const h = recoveryDeps({ outcomes: ['definitive'] });
    const recovery = createLoginRecovery(h.deps);
    expect(await recovery.recover('anthropic', null, false)).toBe('sign_in');
    expect(h.state.needsLoginAt).not.toBeNull();
    expect(h.held).toEqual([LOGIN_HOLD_FIRST_DELAY_MS]);
  });

  test('a transient refresh holds until the clock, then resumes on success', async () => {
    const h = recoveryDeps({ outcomes: ['transient', 'refreshed'] });
    const recovery = createLoginRecovery(h.deps);
    expect(await recovery.recover('anthropic', null, false)).toBe('refresh_pending');
    expect(recovery.isHeld('anthropic')).toBe(true);
    h.timers.shift()?.();
    await Promise.resolve();
    await new Promise((done) => setTimeout(done, 0));
    expect(h.resumed).toHaveLength(1);
    expect(recovery.isHeld('anthropic')).toBe(false);
  });

  test('a credential write over a held login wakes it without waiting for the clock', async () => {
    const h = recoveryDeps({ outcomes: ['definitive'] });
    const recovery = createLoginRecovery(h.deps);
    await recovery.recover('anthropic', null, false);
    h.state.needsLoginAt = null;
    expect(await recovery.maybeResume('anthropic')).toBe(true);
    expect(h.resumed).toHaveLength(1);
  });

  test('a credential write that lands while the hold installs does not wait for another write', async () => {
    const h = recoveryDeps({
      outcomes: ['definitive'],
      onRefresh: (write) => {
        h.state.needsLoginAt = null;
        void write();
      },
    });
    const recovery = createLoginRecovery(h.deps);
    h.attach(recovery);

    expect(await recovery.recover('anthropic', null, false)).toBe('retry');

    expect(recovery.isHeld('anthropic')).toBe(false);
    expect(h.resumed).toHaveLength(0);
  });

  test('a credential write during the refresh makes the turn retry instead of holding', async () => {
    const h = recoveryDeps({ outcomes: ['definitive'] });
    const recovery = createLoginRecovery(h.deps);
    h.state.needsLoginAt = null;

    const pending = recovery.recover('anthropic', null, false);
    expect(await recovery.maybeResume('anthropic')).toBe(false);

    expect(await pending).toBe('retry');
    expect(recovery.isHeld('anthropic')).toBe(false);
  });

  test('repeated credential writes resume exactly once', async () => {
    const h = recoveryDeps({ outcomes: ['definitive'] });
    const recovery = createLoginRecovery(h.deps);
    await recovery.recover('anthropic', null, false);

    h.state.needsLoginAt = null;
    expect(await recovery.maybeResume('anthropic')).toBe(true);
    expect(await recovery.maybeResume('anthropic')).toBe(false);

    expect(h.resumed).toHaveLength(1);
  });

  test('a second hold keeps the prompt it already holds', async () => {
    const h = recoveryDeps({ outcomes: ['definitive'] });
    const recovery = createLoginRecovery(h.deps);
    const first = { uuid: 'first', content: 'the original ask' };
    const second = { uuid: 'second', content: 'a later ask' };

    await recovery.recover('anthropic', first, false);
    await recovery.recover('anthropic', second, false);

    expect(h.heldPrompts).toEqual([first, first]);
  });

  test('a rejection that predates a credential write retries instead of asking for sign-in', async () => {
    const h = recoveryDeps({ outcomes: ['skipped'] });
    const recovery = createLoginRecovery(h.deps);
    await recovery.maybeResume('anthropic');

    expect(await recovery.recover('anthropic', null, false, 0)).toBe('retry');
    expect(h.state.needsLoginAt).toBeNull();
    expect(recovery.isHeld('anthropic')).toBe(false);
  });

  test('a health-only change leaves a login hold in place', async () => {
    const h = recoveryDeps({ outcomes: ['definitive'] });
    const recovery = createLoginRecovery(h.deps);
    await recovery.recover('anthropic', null, false);
    expect(await recovery.maybeResume('anthropic')).toBe(false);
    expect(h.resumed).toHaveLength(0);
  });
});

describe('loginHoldDelayMs', () => {
  test('waits the lesser of the refresh clock and the first hold delay', () => {
    expect(loginHoldDelayMs(0, 0)).toBe(LOGIN_HOLD_FIRST_DELAY_MS);
    expect(loginHoldDelayMs(1_000, 0)).toBe(LOGIN_HOLD_FIRST_DELAY_MS);
    expect(loginHoldDelayMs(600_000, 0)).toBe(600_000);
  });
});

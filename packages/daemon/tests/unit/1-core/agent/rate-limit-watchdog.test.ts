import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { FallbackModelEntry } from '@hyperneo/shared';
import {
  BACKOFF_LADDER_MS,
  MAX_RESET_HORIZON_MS,
  RESET_BUFFER_MS,
} from '../../../../src/lib/agent/fallback-recovery';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import {
  RateLimitWatchdog,
  type RateLimitWatchdogDeps,
} from '../../../../src/lib/agent/rate-limit-watchdog';

type Msg = { uuid: string; content: string };

function createMockStateManager(): ProcessingStateManager {
  return {
    getState: mock(() => ({ status: 'idle' })),
    setIdle: mock(async () => {}),
    setRateLimitCooldown: mock(async () => {}),
    setProcessing: mock(async () => {}),
    setQueued: mock(async () => {}),
    setInterrupted: mock(async () => {}),
    setWaitingForInput: mock(async () => {}),
    setCompacting: mock(async () => {}),
    updatePhase: mock(async () => {}),
    detectPhaseFromMessage: mock(async () => {}),
    isProcessing: mock(() => false),
    isIdle: mock(() => true),
    isWaitingForInput: mock(() => false),
    getPendingQuestion: mock(() => null),
    updateQuestionDraft: mock(async () => {}),
    setOnIdleCallback: mock(() => {}),
    restoreFromDatabase: mock(() => {}),
    getIsCompacting: mock(() => false),
  } as unknown as ProcessingStateManager;
}

interface MockDepsOptions {
  chain?: FallbackModelEntry[];
  current?: { provider: string; model: string };
  available?: (e: FallbackModelEntry) => boolean;
  switchSucceeds?: boolean | ((e: FallbackModelEntry) => boolean);
}

function createMockDeps(opts: MockDepsOptions = {}): {
  deps: RateLimitWatchdogDeps;
  setModel: (provider: string, model: string) => void;
  switchAndRetry: ReturnType<typeof mock>;
  notifyPause: ReturnType<typeof mock>;
  notifyResume: ReturnType<typeof mock>;
} {
  let current = opts.current ?? { provider: 'anthropic', model: 'claude-sonnet-4-5' };
  const switchAndRetry = mock(async (_msg: Msg | null, entry: FallbackModelEntry) => {
    current = { provider: entry.provider, model: entry.model };
    return typeof opts.switchSucceeds === 'function'
      ? opts.switchSucceeds(entry)
      : (opts.switchSucceeds ?? true);
  });
  const notifyPause = mock((_payload: unknown) => {});
  const notifyResume = mock(() => {});
  const deps: RateLimitWatchdogDeps = {
    getCurrentModel: () => current,
    resolveChain: () => opts.chain ?? [],
    isEntryAvailable: async (e) => (opts.available ? opts.available(e) : true),
    switchAndRetry,
    notifyPause,
    notifyResume,
  };
  return {
    deps,
    setModel: (p, m) => (current = { provider: p, model: m }),
    switchAndRetry,
    notifyPause,
    notifyResume,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('RateLimitWatchdog', () => {
  let stateManager: ProcessingStateManager;

  beforeEach(() => {
    stateManager = createMockStateManager();
  });

  describe('getState', () => {
    it('returns idle state initially', () => {
      const { deps } = createMockDeps();
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      const state = watchdog.getState();
      expect(state.status).toBe('idle');
      expect(state.retryCount).toBe(0);
      expect(state.maxRetries).toBe(3);
      expect(state.retryAt).toBeNull();
      expect(state.lastUserMessage).toBeNull();
      expect(state.triedEntries).toEqual([]);
      expect(state.fallbackPending).toBe(false);
    });

    it('defaults maxAutoRetries to the full backoff ladder length (every step reachable)', () => {
      const { deps } = createMockDeps();
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      expect(watchdog.getState().maxRetries).toBe(BACKOFF_LADDER_MS.length);
    });
  });

  describe('Phase B — cooldown (chain empty)', () => {
    it('schedules a backoff-ladder cooldown and sets rate_limit_cooldown state', async () => {
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      const result = await watchdog.scheduleRetry('429 rate limit', {
        uuid: 'm1',
        content: 'hi',
      });
      expect(result).toBe(true);
      expect(stateManager.setRateLimitCooldown).toHaveBeenCalledTimes(1);
      expect(watchdog.getState().status).toBe('cooldown');
      expect(watchdog.getState().retryCount).toBe(1);
      expect(watchdog.getState().lastUserMessage).toEqual({ uuid: 'm1', content: 'hi' });
      expect(notifyPause).toHaveBeenCalledTimes(1);
      expect(notifyPause.mock.calls[0][0]).toMatchObject({ kind: 'rate_limit' });
      watchdog.cancel();
    });

    it('schedules a cooldown at a parsed reset time without bumping retryCount (free wait)', async () => {
      const reset = Date.now() + 5 * 60 * 60 * 1000;
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      const result = await watchdog.scheduleRetry(
        `限额将在 ${new Date(reset)
          .toISOString()
          .replace('T', ' ')
          .replace(/\.\d+Z$/, '')} 重置`,
        { uuid: 'm1', content: 'hi' }
      );
      expect(result).toBe(true);
      expect(watchdog.getState().retryCount).toBe(0);
      const cooldownArgs = (stateManager.setRateLimitCooldown as ReturnType<typeof mock>).mock
        .calls[0][0];
      expect(cooldownArgs.retryAt).toBeGreaterThan(Date.now());
      expect(notifyPause.mock.calls[0][0]).toMatchObject({ kind: 'usage_limit' });
      watchdog.cancel();
    });

    it('returns false when lastUserMessage is null', async () => {
      const { deps } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      const result = await watchdog.scheduleRetry('429', null);
      expect(result).toBe(false);
      expect(watchdog.getState().status).toBe('idle');
      expect(watchdog.isPending()).toBe(false);
    });

    it('returns false when max cooldown retries exceeded', async () => {
      const { deps } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 2 });
      const msg = { uuid: 'm1', content: 'x' };
      await watchdog.scheduleRetry('429', msg);
      await watchdog.scheduleRetry('429', msg);
      const result = await watchdog.scheduleRetry('429', msg);
      expect(result).toBe(false);
      expect(watchdog.getState().retryCount).toBe(2);
      watchdog.clearPendingCooldown();
    });

    it('a parsed-reset wait bypasses the maxAutoRetries budget (free wait)', async () => {
      const { deps } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 2 });
      const msg = { uuid: 'm1', content: 'x' };
      await watchdog.scheduleRetry('429', msg);
      await watchdog.scheduleRetry('429', msg);
      expect(watchdog.getState().retryCount).toBe(2);

      const resetIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const result = await watchdog.scheduleRetry(`resets ${resetIso}`, msg);
      expect(result).toBe(true);
      expect(watchdog.getState().retryCount).toBe(2);
      watchdog.cancel();
    });

    it('notifyPause resetAt carries the 30s buffer over the parsed reset time', async () => {
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      const resetAt = Math.floor((Date.now() + 60 * 60 * 1000) / 1000) * 1000;
      const resetIso = new Date(resetAt).toISOString();
      await watchdog.scheduleRetry(`resets ${resetIso}`, { uuid: 'm1', content: 'x' });
      const payload = notifyPause.mock.calls[0][0] as { resetAt?: number };
      expect(payload.resetAt).toBe(resetAt + RESET_BUFFER_MS);
      watchdog.cancel();
    });

    it('increments retryCount only on (non-free) backoff steps', async () => {
      const { deps } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 5 });
      const msg = { uuid: 'm1', content: 'x' };
      await watchdog.scheduleRetry('429', msg);
      expect(watchdog.getState().retryCount).toBe(1);
      await watchdog.scheduleRetry('429', msg);
      expect(watchdog.getState().retryCount).toBe(2);
      watchdog.clearPendingCooldown();
    });
  });

  describe('structured limit hints', () => {
    it('prefers a hinted reset time over the backoff ladder and reports the hinted kind', async () => {
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      const resetAt = Date.now() + 2 * 60 * 60 * 1000;
      const result = await watchdog.scheduleRetry(
        '429',
        { uuid: 'm1', content: 'x' },
        { resetAtMs: resetAt, kind: 'usage_limit' }
      );
      expect(result).toBe(true);
      expect(notifyPause.mock.calls[0][0]).toMatchObject({
        kind: 'usage_limit',
        resetAt: resetAt + RESET_BUFFER_MS,
      });
      const cooldownArgs = (stateManager.setRateLimitCooldown as ReturnType<typeof mock>).mock
        .calls[0][0];
      expect(cooldownArgs.retryAt).toBe(resetAt + RESET_BUFFER_MS);
      expect(watchdog.getState().retryCount).toBe(0);
      watchdog.cancel();
    });

    it('ignores a stale (past) hinted reset and falls back to the backoff ladder', async () => {
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      const result = await watchdog.scheduleRetry(
        '429',
        { uuid: 'm1', content: 'x' },
        { resetAtMs: Date.now() - 1000, kind: 'usage_limit' }
      );
      expect(result).toBe(true);
      expect(notifyPause.mock.calls[0][0]).toMatchObject({ kind: 'usage_limit' });
      expect(watchdog.getState().retryCount).toBe(1);
      watchdog.cancel();
    });

    it('free-waits on a hinted weekly-scale reset even with a zero retry budget', async () => {
      const { deps } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 0 });
      const resetAt = Date.now() + 5 * 24 * 60 * 60 * 1000;
      const result = await watchdog.scheduleRetry(
        '429',
        { uuid: 'm1', content: 'x' },
        {
          resetAtMs: resetAt,
          kind: 'usage_limit',
        }
      );
      expect(result).toBe(true);
      expect(watchdog.getState().retryCount).toBe(0);
      watchdog.cancel();
    });

    it('retains the hint across fallback re-entries within one episode', async () => {
      const A: FallbackModelEntry = { provider: 'p2', model: 'm2' };
      const { deps, notifyPause } = createMockDeps({ chain: [A], switchSucceeds: false });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      const resetAt = Date.now() + 90 * 60 * 1000;
      const result = await watchdog.scheduleRetry(
        '429',
        { uuid: 'm1', content: 'x' },
        { resetAtMs: resetAt, kind: 'usage_limit' }
      );
      expect(result).toBe(true);
      await flush();
      expect(notifyPause).toHaveBeenCalledTimes(1);
      expect(notifyPause.mock.calls[0][0]).toMatchObject({
        kind: 'usage_limit',
        resetAt: resetAt + RESET_BUFFER_MS,
      });
      watchdog.cancel();
    });

    it('clears the hint when the episode turns over to a new user message', async () => {
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      await watchdog.scheduleRetry(
        '429',
        { uuid: 'm1', content: 'x' },
        { resetAtMs: Date.now() + 60 * 60 * 1000, kind: 'usage_limit' }
      );
      await watchdog.scheduleRetry('429', { uuid: 'm2', content: 'y' });
      const payload = notifyPause.mock.calls[1][0] as { kind: string; resetAt?: number };
      expect(payload.kind).toBe('rate_limit');
      expect(payload.resetAt === undefined || payload.resetAt < Date.now() + 60 * 60 * 1000).toBe(
        true
      );
      watchdog.cancel();
    });
  });

  describe('billing-terminal limits (fallback only, never ladder)', () => {
    it('returns false with no cooldown when the chain is empty', async () => {
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      const result = await watchdog.scheduleRetry(
        "403 You've reached your usage limit for this billing cycle",
        { uuid: 'm1', content: 'x' },
        { billingTerminal: true, kind: 'usage_limit' }
      );
      expect(result).toBe(false);
      expect(stateManager.setRateLimitCooldown).not.toHaveBeenCalled();
      expect(notifyPause).not.toHaveBeenCalled();
    });

    it('still switches to a fallback when one is available', async () => {
      const A: FallbackModelEntry = { provider: 'minimax', model: 'abab6.5' };
      const { deps, switchAndRetry } = createMockDeps({ chain: [A] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      const result = await watchdog.scheduleRetry(
        "403 You've reached your usage limit for this billing cycle",
        { uuid: 'm1', content: 'x' },
        { billingTerminal: true, kind: 'usage_limit' }
      );
      expect(result).toBe(true);
      await flush();
      expect(switchAndRetry).toHaveBeenCalledTimes(1);
      expect(stateManager.setRateLimitCooldown).not.toHaveBeenCalled();
    });

    it('surfaces a manual-retry pause instead of a ladder cooldown when a billing fallback switch fails', async () => {
      const A: FallbackModelEntry = { provider: 'minimax', model: 'abab6.5' };
      const { deps, notifyPause } = createMockDeps({ chain: [A], switchSucceeds: false });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      await watchdog.scheduleRetry(
        "403 You've reached your usage limit for this billing cycle",
        { uuid: 'm1', content: 'x' },
        { billingTerminal: true, kind: 'usage_limit' }
      );
      await flush();
      await flush();
      const cooldownCalls = (stateManager.setRateLimitCooldown as ReturnType<typeof mock>).mock
        .calls;
      expect(cooldownCalls).toHaveLength(1);
      const [cooldownState] = cooldownCalls[0] as [{ retryAt: number }];
      expect(cooldownState.retryAt).toBeLessThanOrEqual(Date.now());
      expect(notifyPause).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'usage_limit', reason: 'billing-terminal' })
      );
      expect(watchdog.getState().status).toBe('idle');
      expect(watchdog.getState().retryAt).toBeNull();
      expect(watchdog.isRecoveryPending()).toBe(true);
      expect(watchdog.isManualRecoveryPause()).toBe(true);
      expect(watchdog.retryNow()).toBe(true);
      await flush();
      expect(watchdog.isRecoveryPending()).toBe(false);
    });

    it('does not publish a stale billing pause when the episode is cancelled mid-write', async () => {
      const A: FallbackModelEntry = { provider: 'minimax', model: 'abab6.5' };
      let releaseWrite: (() => void) | undefined;
      const writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      stateManager.setRateLimitCooldown = mock(async () => {
        await writeGate;
      });
      const { deps, notifyPause } = createMockDeps({ chain: [A], switchSucceeds: false });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      await watchdog.scheduleRetry(
        "403 You've reached your usage limit for this billing cycle",
        { uuid: 'm1', content: 'x' },
        { billingTerminal: true, kind: 'usage_limit' }
      );
      await flush();
      await flush();
      watchdog.cancel(false);
      releaseWrite?.();
      await flush();
      await flush();
      expect(notifyPause).not.toHaveBeenCalled();
    });
  });

  describe('retry-in-flight recovery state', () => {
    it('keeps isRecoveryPending true while the retry callback is running', async () => {
      const { deps } = createMockDeps();
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 9 });
      let releaseRetry: (() => void) | undefined;
      const retryGate = new Promise<void>((resolve) => {
        releaseRetry = resolve;
      });
      watchdog.setRetryCallback(async () => {
        await retryGate;
        return true;
      });

      await watchdog.scheduleRetry('429 rate limit', { uuid: 'm1', content: 'hi' });
      expect(watchdog.retryNow()).toBe(true);
      expect(watchdog.isRecoveryPending()).toBe(true);

      releaseRetry?.();
      await flush();
      await flush();
      expect(watchdog.isRecoveryPending()).toBe(false);
    });

    it('keeps isRecoveryPending true while the immediate fallback switch is starting the retry', async () => {
      const A: FallbackModelEntry = { provider: 'glm', model: 'glm-4.6' };
      let releaseSwitch: (() => void) | undefined;
      const switchGate = new Promise<void>((resolve) => {
        releaseSwitch = resolve;
      });
      const { deps } = createMockDeps({ chain: [A] });
      const gatedSwitch = mock(async () => {
        watchdog.clearPendingCooldown();
        await switchGate;
        return true;
      });
      deps.switchAndRetry = gatedSwitch as unknown as typeof deps.switchAndRetry;
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 9 });

      await watchdog.scheduleRetry('429 rate limit', { uuid: 'm1', content: 'hi' });
      await flush();
      expect(gatedSwitch).toHaveBeenCalledTimes(1);
      expect(watchdog.isRecoveryPending()).toBe(true);

      releaseSwitch?.();
      await flush();
      await flush();
      expect(watchdog.isRecoveryPending()).toBe(false);
    });
  });

  describe('post-await write fencing for superseded episodes', () => {
    it('does not write triedKeys when the episode is superseded during current-model resolution', async () => {
      let resolveModel!: () => void;
      const { deps } = createMockDeps({ chain: [] });
      deps.resolveModelId = (_p: string, _model: string) =>
        new Promise<string>((r) => {
          resolveModel = () => r('claude-sonnet-4-5');
        });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      const pending = watchdog.scheduleRetry('429', { uuid: 'm1', content: 'x' });
      await flush();
      watchdog.cancel();
      resolveModel();
      const result = await pending;
      await flush();
      expect(result).toBe(true);
      expect(watchdog.getState().triedEntries).toEqual([]);
      expect(watchdog.getState().fallbackChain).toBeNull();
      expect(watchdog.getState().retryCount).toBe(0);
    });

    it('does not write the fallback chain when the episode is superseded during chain resolution', async () => {
      const A: FallbackModelEntry = { provider: 'glm', model: 'glm-a' };
      let resolveChain!: () => void;
      const { deps } = createMockDeps({ chain: [A] });
      deps.resolveChain = () =>
        new Promise<FallbackModelEntry[]>((r) => {
          resolveChain = () => r([A]);
        });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      const pending = watchdog.scheduleRetry('429', { uuid: 'm1', content: 'x' });
      await flush();
      watchdog.cancel();
      resolveChain();
      const result = await pending;
      await flush();
      expect(result).toBe(true);
      expect(watchdog.getState().fallbackChain).toBeNull();
      expect(watchdog.isPending()).toBe(false);
    });

    it('does not charge retryCount when the episode is superseded during the availability scan', async () => {
      const A: FallbackModelEntry = { provider: 'glm', model: 'glm-a' };
      let releaseAvailability!: () => void;
      const { deps } = createMockDeps({ chain: [A], available: () => false });
      deps.isEntryAvailable = () =>
        new Promise<boolean>((resolve) => {
          releaseAvailability = () => resolve(false);
        });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      const pending = watchdog.scheduleRetry('429', { uuid: 'm1', content: 'x' });
      await flush();
      watchdog.cancel();
      releaseAvailability();
      const result = await pending;
      await flush();
      expect(result).toBe(true);
      expect(watchdog.getState().retryCount).toBe(0);
    });

    it("a superseded cooldown retry's finalizer does not clear the successor's in-flight flag", async () => {
      const resolvers: Array<(ok: boolean) => void> = [];
      const retryCallback = mock(
        () =>
          new Promise<boolean>((resolve) => {
            resolvers.push(resolve);
          })
      );
      const { deps } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      watchdog.setRetryCallback(retryCallback);

      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'x' });
      expect(watchdog.retryNow()).toBe(true);
      await flush();
      expect(resolvers.length).toBe(1);

      watchdog.cancel();
      await watchdog.scheduleRetry('429', { uuid: 'm2', content: 'y' });
      expect(watchdog.retryNow()).toBe(true);
      await flush();
      expect(resolvers.length).toBe(2);
      expect(watchdog.isRecoveryPending()).toBe(true);

      resolvers[0]?.(true);
      await flush();
      await flush();
      expect(watchdog.isRecoveryPending()).toBe(true);

      resolvers[1]?.(true);
      await flush();
      await flush();
      expect(watchdog.isRecoveryPending()).toBe(false);
    });

    it("a superseded fallback switch's finalizer does not clear the successor's pending switch", async () => {
      const A: FallbackModelEntry = { provider: 'glm', model: 'glm-a' };
      const resolvers: Array<(ok: boolean) => void> = [];
      const switchAndRetry = mock(
        () =>
          new Promise<boolean>((resolve) => {
            resolvers.push(resolve);
          })
      );
      const { deps } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
        chain: [A],
      });
      deps.switchAndRetry = switchAndRetry as unknown as typeof deps.switchAndRetry;
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);

      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'x' });
      await flush();
      expect(resolvers.length).toBe(1);

      watchdog.cancel();
      await watchdog.scheduleRetry('429', { uuid: 'm2', content: 'y' });
      await flush();
      expect(resolvers.length).toBe(2);
      expect(watchdog.getState().fallbackPending).toBe(true);
      expect(watchdog.isRecoveryPending()).toBe(true);

      resolvers[0]?.(true);
      await flush();
      await flush();
      expect(watchdog.getState().fallbackPending).toBe(true);
      expect(watchdog.isRecoveryPending()).toBe(true);

      resolvers[1]?.(true);
      await flush();
      await flush();
      expect(watchdog.getState().fallbackPending).toBe(false);
      expect(watchdog.isRecoveryPending()).toBe(false);
    });

    it('clears the in-flight flag when a cancelled retry settles without a successor', async () => {
      const { deps } = createMockDeps({ chain: [] });
      let releaseRetry: (() => void) | undefined;
      const retryGate = new Promise<void>((resolve) => {
        releaseRetry = resolve;
      });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      watchdog.setRetryCallback(async () => {
        await retryGate;
        return true;
      });
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'x' });
      expect(watchdog.retryNow()).toBe(true);
      watchdog.cancel();
      releaseRetry?.();
      await flush();
      await flush();
      expect(watchdog.isRecoveryPending()).toBe(false);
    });
  });

  describe('LLM refinement of unparseable limits', () => {
    it('re-arms the cooldown at the LLM-provided reset when the ladder was armed', async () => {
      const resetAt = Date.now() + 2 * 60 * 60 * 1000;
      const classify = mock(async () => ({
        resetAtMs: resetAt,
        kind: 'usage_limit' as const,
        notALimit: false,
      }));
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify;
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry('firewall throttled, no timestamps in body', {
        uuid: 'm1',
        content: 'x',
      });
      await flush();
      await flush();

      expect(classify).toHaveBeenCalledTimes(1);
      const calls = (stateManager.setRateLimitCooldown as ReturnType<typeof mock>).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[1][0].retryAt).toBe(resetAt + RESET_BUFFER_MS);
      expect(notifyPause.mock.calls[1][0]).toMatchObject({
        kind: 'usage_limit',
        resetAt: resetAt + RESET_BUFFER_MS,
      });
      watchdog.cancel();
    });

    it('aborts the refined cooldown when the query generation moved during classification (B5e)', async () => {
      const resetAt = Date.now() + 2 * 60 * 60 * 1000;
      let resolveClassification!: (value: {
        resetAtMs: number | null;
        kind: 'usage_limit' | null;
        notALimit: boolean;
      }) => void;
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      let queryGeneration = 3;
      deps.getQueryGeneration = () => queryGeneration;
      deps.classifyUnknownLimit = () =>
        new Promise((resolve) => {
          resolveClassification = () =>
            resolve({ resetAtMs: resetAt, kind: 'usage_limit', notALimit: false });
        });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry(
        'firewall throttled, no timestamps in body',
        {
          uuid: 'm1',
          content: 'x',
        },
        undefined,
        3
      );
      queryGeneration = 9;
      resolveClassification({ resetAtMs: resetAt, kind: 'usage_limit', notALimit: false });
      await flush();
      await flush();

      expect(notifyPause).toHaveBeenCalledTimes(1);
      watchdog.cancel();
    });

    it('does not re-arm when the LLM says the error is not a limit', async () => {
      const classify = mock(async () => ({
        resetAtMs: null,
        kind: null,
        notALimit: true,
      }));
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify;
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry('upstream hiccup', { uuid: 'm1', content: 'x' });
      await flush();
      await flush();

      expect(classify).toHaveBeenCalledTimes(1);
      expect(notifyPause).toHaveBeenCalledTimes(1);
      watchdog.cancel();
    });

    it('skips refinement when a parsed reset already scheduled the cooldown', async () => {
      const classify = mock(async () => ({
        resetAtMs: Date.now() + 60 * 60 * 1000,
        kind: 'usage_limit' as const,
        notALimit: false,
      }));
      const { deps } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify;
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      const resetIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await watchdog.scheduleRetry(`resets ${resetIso}`, { uuid: 'm1', content: 'x' });
      await flush();

      expect(classify).not.toHaveBeenCalled();
      watchdog.cancel();
    });

    it('does not re-arm after the episode is cancelled mid-lookup', async () => {
      let resolveClassify: (value: {
        resetAtMs: number;
        kind: 'usage_limit';
        notALimit: false;
      }) => void = () => {};
      const classify = mock(
        () =>
          new Promise((resolve) => {
            resolveClassify = resolve;
          })
      );
      const { deps } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify as unknown as ReturnType<typeof mock>;
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry('throttled by waf', { uuid: 'm1', content: 'x' });
      watchdog.cancel();
      resolveClassify({
        resetAtMs: Date.now() + 2 * 60 * 60 * 1000,
        kind: 'usage_limit',
        notALimit: false,
      });
      await flush();
      await flush();

      expect(
        (stateManager.setRateLimitCooldown as ReturnType<typeof mock>).mock.calls
      ).toHaveLength(1);
    });

    it('clears the ladder timer when the refined reset re-arms the cooldown', async () => {
      let resolveClassify: (value: {
        resetAtMs: number;
        kind: 'usage_limit';
        notALimit: false;
      }) => void = () => {};
      const classify = mock(
        () =>
          new Promise((resolve) => {
            resolveClassify = resolve;
          })
      );
      const { deps } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify as unknown as ReturnType<typeof mock>;
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      const realClearTimeout = globalThis.clearTimeout;
      const clearedHandles: unknown[] = [];
      globalThis.clearTimeout = ((handle: unknown) => {
        clearedHandles.push(handle);
        return realClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
      }) as typeof clearTimeout;

      try {
        await watchdog.scheduleRetry('throttled by waf', { uuid: 'm1', content: 'x' });
        const ladderTimer = (watchdog as unknown as { cooldownTimer: unknown }).cooldownTimer;
        expect(ladderTimer).not.toBeNull();

        resolveClassify({
          resetAtMs: Date.now() + 2 * 60 * 60 * 1000,
          kind: 'usage_limit',
          notALimit: false,
        });
        await flush();
        await flush();

        const refinedTimer = (watchdog as unknown as { cooldownTimer: unknown }).cooldownTimer;
        expect(refinedTimer).not.toBeNull();
        expect(refinedTimer).not.toBe(ladderTimer);
        expect(clearedHandles).toContain(ladderTimer);
      } finally {
        globalThis.clearTimeout = realClearTimeout;
        watchdog.cancel();
      }
    });

    it('refunds the ladder charge when refinement converts to a free wait', async () => {
      const resetAt = Date.now() + 2 * 60 * 60 * 1000;
      const classify = mock(async () => ({
        resetAtMs: resetAt,
        kind: 'usage_limit' as const,
        notALimit: false,
      }));
      const { deps } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify;
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry('firewall throttled, no timestamps in body', {
        uuid: 'm1',
        content: 'x',
      });
      await flush();
      await flush();

      expect(watchdog.getState().retryCount).toBe(0);
      watchdog.cancel();
    });

    it('keeps the ladder charge visible until the refined cooldown owns, but persists the refund', async () => {
      const classify = mock(async () => ({
        resetAtMs: Date.now() + 2 * 60 * 60 * 1000,
        kind: 'usage_limit' as const,
        notALimit: false,
      }));
      const { deps } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify;
      const originalSet = stateManager.setRateLimitCooldown as ReturnType<typeof mock>;
      let releaseStateWrite: () => void = () => {};
      const writeGate = new Promise<void>((resolve) => {
        releaseStateWrite = resolve;
      });
      let stateWrites = 0;
      (stateManager as unknown as { setRateLimitCooldown: unknown }).setRateLimitCooldown = mock(
        async (payload: unknown) => {
          stateWrites += 1;
          if (stateWrites === 2) await writeGate;
          return originalSet(payload);
        }
      );
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry('throttled by waf', { uuid: 'm1', content: 'x' });
      await flush();
      expect(watchdog.getState().retryCount).toBe(1);

      releaseStateWrite();
      await flush();
      await flush();

      expect(
        (stateManager.setRateLimitCooldown as ReturnType<typeof mock>).mock.calls[1][0]
      ).toMatchObject({ retryCount: 0 });
      expect(watchdog.getState().retryCount).toBe(0);
      watchdog.cancel();
    });

    it('does not overwrite a newer cooldown armed while classification is in flight', async () => {
      let resolveClassify: (value: {
        resetAtMs: number;
        kind: 'usage_limit';
        notALimit: false;
      }) => void = () => {};
      const classify = mock(
        () =>
          new Promise((resolve) => {
            resolveClassify = resolve;
          })
      );
      const { deps } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify as unknown as ReturnType<typeof mock>;
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry('throttled by waf', { uuid: 'm1', content: 'x' });
      expect(watchdog.retryNow()).toBe(true);
      await flush();

      resolveClassify({
        resetAtMs: Date.now() + 2 * 60 * 60 * 1000,
        kind: 'usage_limit',
        notALimit: false,
      });
      await flush();
      await flush();

      expect(
        (stateManager.setRateLimitCooldown as ReturnType<typeof mock>).mock.calls
      ).toHaveLength(1);
    });

    it('keeps a newer hint supplied while the refinement write was pending', async () => {
      const classify = mock(async () => ({
        resetAtMs: Date.now() + 2 * 60 * 60 * 1000,
        kind: 'usage_limit' as const,
        notALimit: false,
      }));
      const { deps } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify;
      const originalSet = stateManager.setRateLimitCooldown as ReturnType<typeof mock>;
      let releaseStateWrite: () => void = () => {};
      const writeGate = new Promise<void>((resolve) => {
        releaseStateWrite = resolve;
      });
      let stateWrites = 0;
      (stateManager as unknown as { setRateLimitCooldown: unknown }).setRateLimitCooldown = mock(
        async (payload: unknown) => {
          stateWrites += 1;
          if (stateWrites === 2) await writeGate;
          return originalSet(payload);
        }
      );
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry('throttled by waf', { uuid: 'm1', content: 'x' });
      await flush();
      const newerHint = {
        kind: 'usage_limit' as const,
        resetAtMs: Date.now() + 3 * 60 * 60 * 1000,
      };
      (watchdog as unknown as { lastHint: unknown }).lastHint = newerHint;
      releaseStateWrite();
      await flush();
      await flush();

      expect((watchdog as unknown as { lastHint: unknown }).lastHint).toBe(newerHint);
      watchdog.cancel();
    });

    it('does not clobber a newer cooldown taken during the refinement state write', async () => {
      const classify = mock(async () => ({
        resetAtMs: Date.now() + 2 * 60 * 60 * 1000,
        kind: 'usage_limit' as const,
        notALimit: false,
      }));
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify;
      const originalSet = stateManager.setRateLimitCooldown as ReturnType<typeof mock>;
      let releaseStateWrite: () => void = () => {};
      const writeGate = new Promise<void>((resolve) => {
        releaseStateWrite = resolve;
      });
      let stateWrites = 0;
      (stateManager as unknown as { setRateLimitCooldown: unknown }).setRateLimitCooldown = mock(
        async (payload: unknown) => {
          stateWrites += 1;
          if (stateWrites === 2) await writeGate;
          return originalSet(payload);
        }
      );
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry('throttled by waf', { uuid: 'm1', content: 'x' });
      await flush();
      watchdog.retryNow();
      releaseStateWrite();
      await flush();
      await flush();

      expect(notifyPause).toHaveBeenCalledTimes(1);
      expect((watchdog as unknown as { cooldownTimer: unknown }).cooldownTimer).toBeNull();
      expect(watchdog.getState().retryCount).toBe(1);
    });

    it('restores the persisted state of a newer cooldown after a stale refinement write', async () => {
      const classify = mock(async () => ({
        resetAtMs: Date.now() + 2 * 60 * 60 * 1000,
        kind: 'usage_limit' as const,
        notALimit: false,
      }));
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify;
      const originalSet = stateManager.setRateLimitCooldown as ReturnType<typeof mock>;
      let releaseStateWrite: () => void = () => {};
      const writeGate = new Promise<void>((resolve) => {
        releaseStateWrite = resolve;
      });
      let stateWrites = 0;
      (stateManager as unknown as { setRateLimitCooldown: unknown }).setRateLimitCooldown = mock(
        async (payload: unknown) => {
          stateWrites += 1;
          if (stateWrites === 2) await writeGate;
          return originalSet(payload);
        }
      );
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry('throttled by waf', { uuid: 'm1', content: 'x' });
      await flush();
      await flush();
      await watchdog.scheduleRetry('throttled by proxy again', { uuid: 'm1', content: 'x' });
      await flush();
      releaseStateWrite();
      await flush();
      await flush();

      const writes = originalSet.mock.calls;
      expect(notifyPause.mock.calls.length).toBeGreaterThanOrEqual(2);
      const stalePayload = writes[0][0] as { retryAt: number };
      const lastPayload = writes[writes.length - 1][0] as { retryAt: number };
      const ownerRetryAt = (watchdog as unknown as { currentRetryAt: number | null })
        .currentRetryAt;
      expect(ownerRetryAt).not.toBeNull();
      expect(lastPayload.retryAt).toBe(ownerRetryAt);
      expect(lastPayload.retryAt).not.toBe(stalePayload.retryAt);
      expect((watchdog as unknown as { cooldownTimer: unknown }).cooldownTimer).not.toBeNull();
      expect(watchdog.getState().limitKind).not.toBe('usage_limit');
      watchdog.cancel();
    });

    it('persists an expired cooldown when ownership was lost to a retry with no live timer', async () => {
      const classify = mock(async () => ({
        resetAtMs: Date.now() + 2 * 60 * 60 * 1000,
        kind: 'usage_limit' as const,
        notALimit: false,
      }));
      const { deps } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify;
      const originalSet = stateManager.setRateLimitCooldown as ReturnType<typeof mock>;
      let releaseStateWrite: () => void = () => {};
      const writeGate = new Promise<void>((resolve) => {
        releaseStateWrite = resolve;
      });
      let stateWrites = 0;
      (stateManager as unknown as { setRateLimitCooldown: unknown }).setRateLimitCooldown = mock(
        async (payload: unknown) => {
          stateWrites += 1;
          if (stateWrites === 2) await writeGate;
          return originalSet(payload);
        }
      );
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry('throttled by waf', { uuid: 'm1', content: 'x' });
      await flush();
      await flush();
      watchdog.retryNow();
      releaseStateWrite();
      await flush();
      await flush();

      const lastPayload = originalSet.mock.calls[originalSet.mock.calls.length - 1][0] as {
        retryAt: number;
      };
      expect(lastPayload.retryAt).toBeLessThanOrEqual(Date.now());
      watchdog.cancel();
    });

    it('reconciles persisted state and hint when the refined write throws', async () => {
      const classify = mock(async () => ({
        resetAtMs: Date.now() + 2 * 60 * 60 * 1000,
        kind: 'usage_limit' as const,
        notALimit: false,
      }));
      const { deps } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify;
      const originalSet = stateManager.setRateLimitCooldown as ReturnType<typeof mock>;
      let stateWrites = 0;
      (stateManager as unknown as { setRateLimitCooldown: unknown }).setRateLimitCooldown = mock(
        async (payload: unknown) => {
          stateWrites += 1;
          if (stateWrites === 2) {
            throw new Error('publish rejected after persist');
          }
          return originalSet(payload);
        }
      );
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry('throttled by waf', { uuid: 'm1', content: 'x' });
      await flush();
      await flush();
      await flush();

      const writes = originalSet.mock.calls;
      const lastPayload = writes[writes.length - 1][0] as { retryAt: number };
      const ownerRetryAt = (watchdog as unknown as { currentRetryAt: number | null })
        .currentRetryAt;
      expect(ownerRetryAt).not.toBeNull();
      expect(lastPayload.retryAt).toBe(ownerRetryAt);
      expect(watchdog.getState().retryCount).toBe(1);
      watchdog.cancel();
    });

    it('refines a newer cooldown even while an older refinement is in flight', async () => {
      const classifyCalls: string[] = [];
      let releaseAll: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseAll = resolve;
      });
      const classify = mock(() => {
        return new Promise<{ resetAtMs: number; kind: 'usage_limit'; notALimit: boolean }>(
          (resolve) => {
            void gate.then(() =>
              resolve({
                resetAtMs: Date.now() + 2 * 60 * 60 * 1000,
                kind: 'usage_limit',
                notALimit: false,
              })
            );
          }
        ).then((value) => {
          return value;
        });
      });
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = async (rawText: string) => {
        classifyCalls.push(rawText);
        return classify() as Promise<{
          resetAtMs: number;
          kind: 'usage_limit';
          notALimit: boolean;
        }>;
      };
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry('throttled by waf', { uuid: 'm1', content: 'x' });
      await flush();
      await watchdog.scheduleRetry('throttled by proxy again', { uuid: 'm1', content: 'x' });
      await flush();

      expect(classifyCalls).toEqual(['throttled by waf', 'throttled by proxy again']);

      releaseAll?.();
      await flush();
      await flush();
      await flush();

      expect(notifyPause.mock.calls.length).toBeGreaterThanOrEqual(3);
      watchdog.cancel();
    });

    it('does not start refinement when the scheduling call lost ownership', async () => {
      const classify = mock(async () => ({
        resetAtMs: Date.now() + 2 * 60 * 60 * 1000,
        kind: 'usage_limit' as const,
        notALimit: false,
      }));
      const { deps } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify;
      const originalSet = stateManager.setRateLimitCooldown as ReturnType<typeof mock>;
      let releaseFirstWrite: () => void = () => {};
      const writeGate = new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      });
      let stateWrites = 0;
      (stateManager as unknown as { setRateLimitCooldown: unknown }).setRateLimitCooldown = mock(
        async (payload: unknown) => {
          stateWrites += 1;
          if (stateWrites === 1) await writeGate;
          return originalSet(payload);
        }
      );
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      const first = watchdog.scheduleRetry('throttled by waf', { uuid: 'm1', content: 'x' });
      await flush();
      await watchdog.scheduleRetry('throttled by proxy again', { uuid: 'm1', content: 'x' });
      await flush();
      releaseFirstWrite();
      await first;
      await flush();
      await flush();

      expect(classify.mock.calls.map((c) => c[0])).toEqual(['throttled by proxy again']);
      watchdog.cancel();
    });
  });

  describe('Phase A — immediate fallback switch', () => {
    const A: FallbackModelEntry = { provider: 'glm', model: 'glm-4.6' };
    const B: FallbackModelEntry = { provider: 'minimax', model: 'abab6.5' };

    it('switches to the next available fallback and retries without a cooldown', async () => {
      const { deps, switchAndRetry } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
        chain: [A, B],
      });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      const result = await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(result).toBe(true);
      await flush();
      expect(switchAndRetry).toHaveBeenCalledTimes(1);
      expect(switchAndRetry.mock.calls[0][1]).toEqual(A);
      expect(stateManager.setRateLimitCooldown).not.toHaveBeenCalled();
      expect(watchdog.getState().retryCount).toBe(0);
      expect(watchdog.getState().triedEntries).toContain('anthropic/sonnet');
    });

    it('skips unavailable entries', async () => {
      const { deps, switchAndRetry } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
        chain: [A, B],
        available: (e) => e !== A,
      });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      expect(switchAndRetry.mock.calls[0][1]).toEqual(B);
    });

    it('dedupes the current model against an alias/canonical fallback via resolveModelId', async () => {
      const canonical: FallbackModelEntry = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
      const other: FallbackModelEntry = { provider: 'glm', model: 'glm-4.6' };
      const { deps, switchAndRetry } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
        chain: [canonical, other],
      });
      deps.resolveModelId = async (_p, m) =>
        m === 'sonnet' || m === 'claude-sonnet-4-5' ? 'claude-sonnet-4-5' : m;
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      expect(switchAndRetry.mock.calls[0][1]).toEqual(other);
    });

    it('advances to the next entry when a switch fails, without bumping retryCount', async () => {
      const calls = 0;
      const { deps, switchAndRetry } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
        chain: [A, B],
        switchSucceeds: (e) => e !== A,
      });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      expect(switchAndRetry).toHaveBeenCalledTimes(2);
      expect(switchAndRetry.mock.calls[0][1]).toEqual(A);
      expect(switchAndRetry.mock.calls[1][1]).toEqual(B);
      expect(watchdog.getState().retryCount).toBe(0);
      expect(stateManager.setRateLimitCooldown).not.toHaveBeenCalled();
    });

    it('falls through to a cooldown when every switch fails and the chain is exhausted', async () => {
      const { deps } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
        chain: [A],
        switchSucceeds: () => false,
      });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      expect(stateManager.setRateLimitCooldown).toHaveBeenCalledTimes(1);
      watchdog.cancel();
    });

    it('aborts the fallback switch if the episode is superseded during resolution', async () => {
      const A: FallbackModelEntry = { provider: 'glm', model: 'glm-a' };
      let resolveChain!: () => void;
      const { deps, switchAndRetry } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
      });
      deps.resolveChain = () =>
        new Promise<FallbackModelEntry[]>((r) => {
          resolveChain = () => r([A]);
        });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      const pending = watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      watchdog.cancel();
      resolveChain();
      const result = await pending;
      await flush();
      expect(result).toBe(true);
      expect(switchAndRetry).not.toHaveBeenCalled();
      expect(stateManager.setRateLimitCooldown).not.toHaveBeenCalled();
      expect(watchdog.isPending()).toBe(false);
    });

    it('aborts the fallback switch if the query generation moved during resolution (B5e)', async () => {
      const A: FallbackModelEntry = { provider: 'glm', model: 'glm-a' };
      let resolveChain!: () => void;
      const { deps, switchAndRetry } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
      });
      let queryGeneration = 3;
      deps.getQueryGeneration = () => queryGeneration;
      deps.resolveChain = () =>
        new Promise<FallbackModelEntry[]>((r) => {
          resolveChain = () => r([A]);
        });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      const pending = watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' }, undefined, 3);
      await flush();
      queryGeneration = 9;
      resolveChain();
      const result = await pending;
      await flush();
      expect(result).toBe(true);
      expect(switchAndRetry).not.toHaveBeenCalled();
      expect(stateManager.setRateLimitCooldown).not.toHaveBeenCalled();
      expect(watchdog.isPending()).toBe(false);
    });
  });

  describe('episode tracking across repeated 429', () => {
    const A: FallbackModelEntry = { provider: 'glm', model: 'glm-a' };
    const B: FallbackModelEntry = { provider: 'minimax', model: 'mm-b' };

    it('walks A → B → cooldown as successive models 429', async () => {
      const { deps, switchAndRetry, setModel } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
        chain: [A, B],
      });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      expect(switchAndRetry.mock.calls[0][1]).toEqual(A);
      setModel(A.provider, A.model);

      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      expect(switchAndRetry.mock.calls[1][1]).toEqual(B);
      setModel(B.provider, B.model);

      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(stateManager.setRateLimitCooldown).toHaveBeenCalledTimes(1);
      expect(watchdog.getState().retryCount).toBe(1);
      watchdog.cancel();
    });

    it('maxAutoRetries counts only cooldowns, not fallback switches', async () => {
      const { deps, switchAndRetry, setModel } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
        chain: [A, B],
      });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 2 });
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      setModel(A.provider, A.model);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      setModel(B.provider, B.model);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(watchdog.getState().retryCount).toBe(1);
      watchdog.clearPendingCooldown();
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(watchdog.getState().retryCount).toBe(2);
      watchdog.clearPendingCooldown();
      const result = await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(result).toBe(false);
      expect(switchAndRetry).toHaveBeenCalledTimes(2);
    });

    it('a new user turn (different UUID) starts a fresh episode with a full budget', async () => {
      const { deps } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 1 });
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'x' });
      expect(watchdog.getState().retryCount).toBe(1);
      const result = await watchdog.scheduleRetry('429', { uuid: 'm2', content: 'y' });
      expect(result).toBe(true);
      expect(watchdog.getState().retryCount).toBe(1);
      watchdog.clearPendingCooldown();
    });

    it('a new user turn re-arms the fallback chain (tried entries cleared)', async () => {
      const A: FallbackModelEntry = { provider: 'glm', model: 'glm-a' };
      const { deps, switchAndRetry, setModel } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
        chain: [A],
        switchSucceeds: false,
      });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      await flush();
      expect(switchAndRetry).toHaveBeenCalledTimes(1);
      expect(switchAndRetry.mock.calls[0][1]).toEqual(A);

      setModel('anthropic', 'sonnet');
      await watchdog.scheduleRetry('429', { uuid: 'm2', content: 'hey' });
      await flush();
      expect(switchAndRetry).toHaveBeenCalledTimes(2);
      expect(switchAndRetry.mock.calls[1][1]).toEqual(A);
      watchdog.cancel();
    });
  });

  describe('cancel / retryNow / reset / destroy', () => {
    it('cancel clears a pending cooldown', async () => {
      const { deps } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(watchdog.isPending()).toBe(true);
      watchdog.cancel();
      expect(watchdog.isPending()).toBe(false);
    });

    it('isRateLimitBannerCancelled is a banner-only signal (not the raw pause flag)', async () => {
      const { deps, notifyResume } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      expect(watchdog.isRateLimitBannerCancelled()).toBe(false);

      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(watchdog.isRateLimitBannerCancelled()).toBe(false);

      watchdog.cancel(false);
      expect(notifyResume).not.toHaveBeenCalled();
      expect(watchdog.retryNow()).toBe(false);
      expect(watchdog.isRateLimitBannerCancelled()).toBe(true);

      watchdog.cancel(true);
      expect(notifyResume).toHaveBeenCalled();
      expect(watchdog.isRateLimitBannerCancelled()).toBe(false);
    });

    it('isRateLimitBannerCancelled is cleared by a new episode / fresh pause', async () => {
      const { deps } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      watchdog.cancel(false);
      expect(watchdog.isRateLimitBannerCancelled()).toBe(true);

      await watchdog.scheduleRetry('429', { uuid: 'm2', content: 'hey' });
      expect(watchdog.isRateLimitBannerCancelled()).toBe(false);
      watchdog.cancel();
    });

    it('retryNow fires the callback and notifies resume once the query starts', async () => {
      const { deps, notifyResume } = createMockDeps({ chain: [] });
      const retryCallback = mock(async () => true);
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      watchdog.setRetryCallback(retryCallback);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      const result = watchdog.retryNow();
      expect(result).toBe(true);
      await flush();
      expect(retryCallback).toHaveBeenCalledTimes(1);
      expect(retryCallback.mock.calls[0][0]).toEqual({ uuid: 'm1', content: 'hi' });
      expect(retryCallback.mock.calls[0][1]).toBeUndefined();
      expect(notifyResume).toHaveBeenCalled();
    });

    it('retryNow does NOT notify resume and reschedules when the query fails to start', async () => {
      const { deps, notifyResume } = createMockDeps({ chain: [] });
      const retryCallback = mock(async () => false);
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      watchdog.setRetryCallback(retryCallback);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(stateManager.setRateLimitCooldown).toHaveBeenCalledTimes(1);
      const result = watchdog.retryNow();
      expect(result).toBe(true);
      await flush();
      expect(retryCallback).toHaveBeenCalledTimes(1);
      expect(notifyResume).not.toHaveBeenCalled();
      expect(watchdog.isPending()).toBe(true);
      expect(watchdog.getState().status).toBe('cooldown');
      watchdog.cancel();
    });

    it('keeps the task paused (no resume) when startup retries are exhausted', async () => {
      const { deps, notifyResume } = createMockDeps({ chain: [] });
      const retryCallback = mock(async () => false);
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      watchdog.setRetryCallback(retryCallback);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(stateManager.setRateLimitCooldown).toHaveBeenCalledTimes(1);

      for (let i = 0; i < 4; i++) {
        expect(watchdog.retryNow()).toBe(true);
        await flush();
      }

      expect(retryCallback).toHaveBeenCalledTimes(4);
      expect(notifyResume).not.toHaveBeenCalled();
      expect(stateManager.setRateLimitCooldown).toHaveBeenCalledTimes(4);
      expect(watchdog.isPending()).toBe(false);
      expect(watchdog.getState().status).toBe('idle');
    });

    it('admits a manual Retry Now after startup retries are exhausted', async () => {
      const { deps } = createMockDeps({ chain: [] });
      const retryCallback = mock(async () => false);
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      watchdog.setRetryCallback(retryCallback);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      for (let i = 0; i < 4; i++) {
        watchdog.retryNow();
        await flush();
      }
      expect(watchdog.isPending()).toBe(false);
      expect(watchdog.retryNow()).toBe(true);
      await flush();
      expect(retryCallback).toHaveBeenCalledTimes(5);
    });

    it('resets the startup-retry budget for a new user-message episode', async () => {
      const { deps } = createMockDeps({ chain: [] });
      const retryCallback = mock(async () => false);
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      watchdog.setRetryCallback(retryCallback);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      for (let i = 0; i < 3; i++) {
        watchdog.retryNow();
        await flush();
      }
      await watchdog.scheduleRetry('429', { uuid: 'm2', content: 'hey' });
      watchdog.retryNow();
      await flush();
      expect(watchdog.isPending()).toBe(true);
      watchdog.cancel();
    });

    it('aborts a cooldown retry superseded mid-callback (no re-arm)', async () => {
      const { deps } = createMockDeps({ chain: [] });
      let resolveCb!: (ok: boolean) => void;
      const retryCallback = mock(
        () =>
          new Promise<boolean>((r) => {
            resolveCb = r;
          })
      );
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      watchdog.setRetryCallback(retryCallback);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(watchdog.retryNow()).toBe(true);
      watchdog.cancel();
      resolveCb(false);
      await flush();
      expect(watchdog.isPending()).toBe(false);
    });

    it('cancel(false) clears the cooldown without notifying resume', async () => {
      const { deps, notifyResume } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(watchdog.isPending()).toBe(true);
      watchdog.cancel(false);
      expect(watchdog.isPending()).toBe(false);
      expect(notifyResume).not.toHaveBeenCalled();
    });

    it('schedules a deferrive cooldown when a fallback re-entry exhausts the budget', async () => {
      const A: FallbackModelEntry = { provider: 'glm', model: 'glm-a' };
      const { deps } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
        chain: [A],
        switchSucceeds: false,
      });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 0 });
      const result = await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(result).toBe(true);
      for (let i = 0; i < 6; i++) await flush();
      expect(watchdog.isPending()).toBe(true);
      expect(stateManager.setRateLimitCooldown).toHaveBeenCalled();
      watchdog.cancel();
    });

    it('does not publish pause or arm a timer if superseded during the cooldown state write', async () => {
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      let resolveStateWrite!: () => void;
      Object.assign(stateManager, {
        setRateLimitCooldown: () =>
          new Promise<void>((resolve) => {
            resolveStateWrite = () => resolve();
          }),
      });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      const pending = watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      watchdog.cancel();
      resolveStateWrite();
      await pending;
      await flush();
      expect(notifyPause).not.toHaveBeenCalled();
      expect(watchdog.isPending()).toBe(false);
    });

    it('does not publish pause or arm a timer if the query generation moved during the cooldown state write (B5e)', async () => {
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      let queryGeneration = 3;
      deps.getQueryGeneration = () => queryGeneration;
      let writeCount = 0;
      let resolveStateWrite!: () => void;
      Object.assign(stateManager, {
        setRateLimitCooldown: () =>
          new Promise<void>((resolve) => {
            writeCount += 1;
            if (writeCount === 1) {
              resolveStateWrite = () => resolve();
            } else {
              resolve();
            }
          }),
      });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      const pending = watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' }, undefined, 3);
      await flush();
      queryGeneration = 9;
      resolveStateWrite();
      await pending;
      await flush();
      expect(notifyPause).not.toHaveBeenCalled();
      expect(watchdog.isPending()).toBe(false);
      watchdog.cancel();
    });

    it('aborts the cooldown schedule if the query generation moved during resolution (B5e)', async () => {
      let resolveChain!: () => void;
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      let queryGeneration = 3;
      deps.getQueryGeneration = () => queryGeneration;
      deps.resolveChain = () =>
        new Promise<FallbackModelEntry[]>((r) => {
          resolveChain = () => r([]);
        });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      const pending = watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' }, undefined, 3);
      await flush();
      queryGeneration = 9;
      resolveChain();
      const result = await pending;
      await flush();
      expect(result).toBe(true);
      expect(stateManager.setRateLimitCooldown).not.toHaveBeenCalled();
      expect(notifyPause).not.toHaveBeenCalled();
      expect(watchdog.isPending()).toBe(false);
    });

    it('aborts before writing episode state when the query moved during model resolution (B5e)', async () => {
      let resolveCanonical!: () => void;
      const { deps } = createMockDeps({ chain: [] });
      let queryGeneration = 3;
      deps.getQueryGeneration = () => queryGeneration;
      deps.resolveModelId = () =>
        new Promise<string>((r) => {
          resolveCanonical = () => r('claude-sonnet');
        });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      const pending = watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' }, undefined, 3);
      await flush();
      queryGeneration = 9;
      resolveCanonical();
      const result = await pending;
      await flush();
      expect(result).toBe(true);
      expect(watchdog.getState().triedEntries).toEqual([]);
      expect(watchdog.getState().retryCount).toBe(0);
      expect(stateManager.setRateLimitCooldown).not.toHaveBeenCalled();
    });

    it('cancel() clears the stale last user message (no re-entry re-arm)', async () => {
      const { deps } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(watchdog.getState().lastUserMessage).toEqual({ uuid: 'm1', content: 'hi' });
      watchdog.cancel();
      expect(watchdog.getState().lastUserMessage).toBeNull();
    });

    it('threads the captured episode generation into switchAndRetry', async () => {
      const A: FallbackModelEntry = { provider: 'glm', model: 'glm-a' };
      let receivedGen: number | undefined;
      const { deps } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
        chain: [A],
      });
      deps.switchAndRetry = mock(async (_msg, _entry, gen: number) => {
        receivedGen = gen;
        return true;
      });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      expect(receivedGen).toBe(0);
    });

    it('threads the captured episode generation into the retry callback', async () => {
      let receivedGen: number | undefined;
      const { deps } = createMockDeps({ chain: [] });
      const retryCallback = mock(async (_msg, _switchTo, gen: number) => {
        receivedGen = gen;
        return true;
      });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      watchdog.setRetryCallback(retryCallback);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(watchdog.retryNow()).toBe(true);
      await flush();
      expect(receivedGen).toBe(0);
    });

    it('aborts the fallback re-entry if superseded during the canonical resolve', async () => {
      const A: FallbackModelEntry = { provider: 'glm', model: 'glm-a' };
      let glmCalls = 0;
      let resolveCanon!: () => void;
      const { deps } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
        chain: [A],
        switchSucceeds: false,
      });
      deps.resolveModelId = (_p: string, model: string) => {
        if (model !== 'glm-a') return Promise.resolve(model);
        glmCalls += 1;
        if (glmCalls === 2) {
          return new Promise<string>((r) => {
            resolveCanon = () => r('glm-a');
          });
        }
        return Promise.resolve('glm-a');
      };
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      watchdog.cancel();
      resolveCanon();
      await flush();
      expect(watchdog.getState().triedEntries).not.toContain('glm/glm-a');
      expect(watchdog.isPending()).toBe(false);
    });

    it('retryNow returns false during a fallback-pending switch', async () => {
      const A: FallbackModelEntry = { provider: 'glm', model: 'glm-4.6' };
      const { deps } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
        chain: [A],
      });
      deps.switchAndRetry = () => new Promise(() => {});
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(watchdog.getState().fallbackPending).toBe(true);
      expect(watchdog.retryNow()).toBe(false);
    });

    it('cancel() during an in-flight fallback aborts it (no switch, no re-enqueue)', async () => {
      const A: FallbackModelEntry = { provider: 'glm', model: 'glm-4.6' };
      let resolveSwitch: (ok: boolean) => void = () => {};
      const switchAndRetry = mock(
        (_msg: Msg | null, _entry: FallbackModelEntry): Promise<boolean> =>
          new Promise<boolean>((r) => (resolveSwitch = r))
      );
      const { deps } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
        chain: [A],
      });
      deps.switchAndRetry = switchAndRetry;
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(watchdog.getState().fallbackPending).toBe(true);

      watchdog.cancel();
      resolveSwitch(true);
      await flush();

      expect(switchAndRetry).toHaveBeenCalledTimes(1);
      expect(watchdog.getState().triedEntries).not.toContain('glm/glm-4.6');
      expect(stateManager.setRateLimitCooldown).not.toHaveBeenCalled();
      expect(watchdog.getState().fallbackPending).toBe(false);
    });

    it('reset clears the episode (tried entries + chain + retryCount)', async () => {
      const A: FallbackModelEntry = { provider: 'glm', model: 'glm-4.6' };
      const { deps } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
        chain: [A],
      });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      watchdog.reset();
      expect(watchdog.getState().status).toBe('idle');
      expect(watchdog.getState().retryCount).toBe(0);
      expect(watchdog.getState().triedEntries).toEqual([]);
      expect(watchdog.getState().fallbackChain).toBeNull();
      expect(watchdog.getState().lastUserMessage).toBeNull();
    });

    it('destroy cancels timers and clears the callback', async () => {
      const { deps } = createMockDeps({ chain: [] });
      const retryCallback = mock(async () => {});
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      watchdog.setRetryCallback(retryCallback);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      watchdog.destroy();
      expect(() => watchdog.retryNow()).not.toThrow();
    });
  });

  describe('decision table pins', () => {
    it('billing-terminal outranks a usable hinted reset: surfaces without any cooldown', async () => {
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      const result = await watchdog.scheduleRetry(
        "403 You've reached your usage limit for this billing cycle",
        { uuid: 'm1', content: 'x' },
        {
          billingTerminal: true,
          kind: 'usage_limit',
          resetAtMs: Date.now() + 2 * 60 * 60 * 1000,
        }
      );
      expect(result).toBe(false);
      expect(stateManager.setRateLimitCooldown).not.toHaveBeenCalled();
      expect(notifyPause).not.toHaveBeenCalled();
      expect(watchdog.isPending()).toBe(false);
    });

    it('billing-terminal surfaces after a non-empty chain is exhausted (all entries unavailable)', async () => {
      const A: FallbackModelEntry = { provider: 'minimax', model: 'abab6.5' };
      const { deps, notifyPause, switchAndRetry } = createMockDeps({
        chain: [A],
        available: () => false,
      });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      const result = await watchdog.scheduleRetry(
        '402 insufficient credits',
        { uuid: 'm1', content: 'x' },
        { billingTerminal: true, kind: 'usage_limit' }
      );
      expect(result).toBe(false);
      expect(switchAndRetry).not.toHaveBeenCalled();
      expect(stateManager.setRateLimitCooldown).not.toHaveBeenCalled();
      expect(notifyPause).not.toHaveBeenCalled();
    });

    it('a hinted reset beyond the 7-day horizon is ignored; the ladder arms but the hinted kind labels the pause', async () => {
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      const before = Date.now();
      const result = await watchdog.scheduleRetry(
        '429',
        { uuid: 'm1', content: 'x' },
        { resetAtMs: Date.now() + MAX_RESET_HORIZON_MS + 60 * 1000, kind: 'usage_limit' }
      );
      expect(result).toBe(true);
      expect(watchdog.getState().retryCount).toBe(1);
      expect(notifyPause.mock.calls[0][0]).toMatchObject({
        kind: 'usage_limit',
        reason: 'backoff-ladder',
      });
      const write = (stateManager.setRateLimitCooldown as ReturnType<typeof mock>).mock.calls[0][0];
      expect(write.retryAt - before).toBeGreaterThan(8 * 60 * 1000);
      expect(write.retryAt - before).toBeLessThan(12 * 60 * 1000);
      watchdog.cancel();
    });

    it('a hinted reset just inside the 7-day horizon still free-waits', async () => {
      const resetAt = Date.now() + MAX_RESET_HORIZON_MS - 60 * 1000;
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      const result = await watchdog.scheduleRetry(
        '429',
        { uuid: 'm1', content: 'x' },
        { resetAtMs: resetAt, kind: 'usage_limit' }
      );
      expect(result).toBe(true);
      expect(watchdog.getState().retryCount).toBe(0);
      expect(notifyPause.mock.calls[0][0]).toMatchObject({
        kind: 'usage_limit',
        reason: 'parsed-reset',
      });
      watchdog.cancel();
    });

    it('the reset-horizon policy value itself is exactly seven days', () => {
      expect(MAX_RESET_HORIZON_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('ladder pause kind falls back to message classification when the hint carries no kind', async () => {
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });
      const result = await watchdog.scheduleRetry(
        'quota exceeded for today',
        { uuid: 'm1', content: 'x' },
        { resetAtMs: Date.now() - 1000 }
      );
      expect(result).toBe(true);
      expect(watchdog.getState().retryCount).toBe(1);
      expect(notifyPause.mock.calls[0][0]).toMatchObject({ kind: 'usage_limit' });
      watchdog.cancel();
    });

    it('the ladder delay steps with the episode retry count (10min step, then 30min step)', async () => {
      const { deps } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 5 });
      const msg = { uuid: 'm1', content: 'x' };
      const beforeFirst = Date.now();
      await watchdog.scheduleRetry('429', msg);
      const beforeSecond = Date.now();
      await watchdog.scheduleRetry('429', msg);
      const writes = (stateManager.setRateLimitCooldown as ReturnType<typeof mock>).mock.calls;
      expect(writes[0][0].retryAt - beforeFirst).toBeGreaterThan(8 * 60 * 1000);
      expect(writes[0][0].retryAt - beforeFirst).toBeLessThan(12 * 60 * 1000);
      expect(writes[1][0].retryAt - beforeSecond).toBeGreaterThan(24 * 60 * 1000);
      expect(writes[1][0].retryAt - beforeSecond).toBeLessThan(36 * 60 * 1000);
      watchdog.cancel();
    });

    it('the ladder policy values themselves are 10 then 30 minutes', () => {
      expect(BACKOFF_LADDER_MS.slice(0, 2)).toEqual([10 * 60 * 1000, 30 * 60 * 1000]);
    });

    it('ignores an LLM-refined reset in the past and keeps the ladder cooldown', async () => {
      const classify = mock(async () => ({
        resetAtMs: Date.now() - 60 * 1000,
        kind: 'usage_limit' as const,
        notALimit: false,
      }));
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify;
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry('throttled by waf', { uuid: 'm1', content: 'x' });
      await flush();
      await flush();

      expect(
        (stateManager.setRateLimitCooldown as ReturnType<typeof mock>).mock.calls
      ).toHaveLength(1);
      expect(notifyPause).toHaveBeenCalledTimes(1);
      watchdog.cancel();
    });

    it('ignores an LLM-refined reset beyond the 7-day horizon and keeps the ladder cooldown', async () => {
      const classify = mock(async () => ({
        resetAtMs: Date.now() + MAX_RESET_HORIZON_MS + 60 * 1000,
        kind: 'usage_limit' as const,
        notALimit: false,
      }));
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify;
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry('throttled by waf', { uuid: 'm1', content: 'x' });
      await flush();
      await flush();

      expect(
        (stateManager.setRateLimitCooldown as ReturnType<typeof mock>).mock.calls
      ).toHaveLength(1);
      expect(notifyPause).toHaveBeenCalledTimes(1);
      watchdog.cancel();
    });

    it('normalizes an epoch-seconds LLM reset and re-arms at reset plus buffer', async () => {
      const resetSec = Math.floor((Date.now() + 2 * 60 * 60 * 1000) / 1000);
      const classify = mock(async () => ({
        resetAtMs: resetSec,
        kind: 'usage_limit' as const,
        notALimit: false,
      }));
      const { deps } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify;
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry('throttled by waf', { uuid: 'm1', content: 'x' });
      await flush();
      await flush();

      const calls = (stateManager.setRateLimitCooldown as ReturnType<typeof mock>).mock.calls;
      expect(calls[1][0].retryAt).toBe(resetSec * 1000 + RESET_BUFFER_MS);
      watchdog.cancel();
    });

    it('a kind-only LLM assessment (no reset) neither re-arms nor relabels the pause', async () => {
      const classify = mock(async () => ({
        resetAtMs: null,
        kind: 'usage_limit' as const,
        notALimit: false,
      }));
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify;
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry('throttled by waf', { uuid: 'm1', content: 'x' });
      await flush();
      await flush();

      expect(notifyPause).toHaveBeenCalledTimes(1);
      expect(notifyPause.mock.calls[0][0]).toMatchObject({ kind: 'rate_limit' });
      expect(watchdog.getState().limitKind).toBe('rate_limit');
      watchdog.cancel();
    });

    it('skips LLM refinement when a usable hinted reset scheduled the cooldown', async () => {
      const classify = mock(async () => ({
        resetAtMs: Date.now() + 3 * 60 * 60 * 1000,
        kind: 'usage_limit' as const,
        notALimit: false,
      }));
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      deps.classifyUnknownLimit = classify;
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 3 });

      await watchdog.scheduleRetry(
        'throttled by waf',
        { uuid: 'm1', content: 'x' },
        { resetAtMs: Date.now() + 2 * 60 * 60 * 1000, kind: 'usage_limit' }
      );
      await flush();
      await flush();

      expect(classify).not.toHaveBeenCalled();
      expect(notifyPause).toHaveBeenCalledTimes(1);
      watchdog.cancel();
    });

    it('isManualRecoveryPause is true after startup retries are exhausted', async () => {
      const { deps } = createMockDeps({ chain: [] });
      const retryCallback = mock(async () => false);
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      watchdog.setRetryCallback(retryCallback);
      expect(watchdog.isManualRecoveryPause()).toBe(false);

      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      for (let i = 0; i < 4; i++) {
        watchdog.retryNow();
        await flush();
      }

      expect(watchdog.isManualRecoveryPause()).toBe(true);
      expect(watchdog.isRecoveryPending()).toBe(true);
    });

    it('reset clears the paused limit kind alongside the episode', async () => {
      const { deps } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      await watchdog.scheduleRetry(
        '429',
        { uuid: 'm1', content: 'x' },
        { resetAtMs: Date.now() + 60 * 60 * 1000, kind: 'usage_limit' }
      );
      expect(watchdog.getState().limitKind).toBe('usage_limit');
      watchdog.reset();
      expect(watchdog.getState().limitKind).toBeNull();
      expect(watchdog.getState().retryCount).toBe(0);
    });
  });
});

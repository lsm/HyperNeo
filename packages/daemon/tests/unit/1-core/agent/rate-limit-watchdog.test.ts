/**
 * RateLimitWatchdog Tests
 *
 * Two-phase recovery:
 * - Phase A: immediate fallback-model switch (free, no retryCount bump).
 * - Phase B: cooldown at a parsed reset time or on the backoff ladder.
 *
 * Plus episode tracking (tried entries), pause/resume surfacing, and the
 * preserved cancel/retryNow/reset/destroy semantics.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
  RateLimitWatchdog,
  type RateLimitWatchdogDeps,
} from '../../../../src/lib/agent/rate-limit-watchdog';
import { RESET_BUFFER_MS } from '../../../../src/lib/agent/fallback-recovery';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { FallbackModelEntry } from '@hyperneo/shared';

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
    // Simulate the session's model actually changing on a successful switch.
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
      // Pause surfaced as a (transient) rate_limit.
      expect(notifyPause).toHaveBeenCalledTimes(1);
      expect(notifyPause.mock.calls[0][0]).toMatchObject({ kind: 'rate_limit' });
      watchdog.cancel();
    });

    it('schedules a cooldown at a parsed reset time without bumping retryCount (free wait)', async () => {
      const reset = Date.now() + 5 * 60 * 60 * 1000; // 5h out
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
      expect(watchdog.getState().retryCount).toBe(0); // free wait
      const cooldownArgs = (stateManager.setRateLimitCooldown as ReturnType<typeof mock>).mock
        .calls[0][0];
      expect(cooldownArgs.retryAt).toBeGreaterThan(Date.now());
      // Usage cap (reset known) → usage_limit.
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
      // Repeated cooldowns on the SAME message (real cooldown-retry re-enqueues
      // the same UUID). scheduleRetry clears the prior timer internally, so no
      // cancel() between iterations — that would start a fresh episode.
      const msg = { uuid: 'm1', content: 'x' };
      await watchdog.scheduleRetry('429', msg);
      await watchdog.scheduleRetry('429', msg);
      // 3rd cooldown attempt (retryCount already 2) → false.
      const result = await watchdog.scheduleRetry('429', msg);
      expect(result).toBe(false);
      expect(watchdog.getState().retryCount).toBe(2);
      watchdog.clearPendingCooldown();
    });

    it('a parsed-reset wait bypasses the maxAutoRetries budget (free wait)', async () => {
      const { deps } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 2 });
      // Burn the budget on backoff (no-timestamp) cooldowns for the same message.
      const msg = { uuid: 'm1', content: 'x' };
      await watchdog.scheduleRetry('429', msg);
      await watchdog.scheduleRetry('429', msg);
      expect(watchdog.getState().retryCount).toBe(2); // at the budget

      // A parseable reset wait is free: returns true AND does not bump retryCount
      // even though we are already at maxAutoRetries.
      const resetIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const result = await watchdog.scheduleRetry(`resets ${resetIso}`, msg);
      expect(result).toBe(true);
      expect(watchdog.getState().retryCount).toBe(2); // unchanged — free wait
      watchdog.cancel();
    });

    it('notifyPause resetAt carries the 30s buffer over the parsed reset time', async () => {
      const { deps, notifyPause } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      // Use a whole-second reset so the second-granularity ISO parse is exact.
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
      // No cooldown scheduled for a fallback switch.
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
      // Session is configured with alias `sonnet`; the fallback chain lists the
      // canonical `claude-sonnet-4-5`. Without canonical resolution the entry
      // looks new and the watchdog would switch to the SAME model forever.
      const canonical: FallbackModelEntry = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
      const other: FallbackModelEntry = { provider: 'glm', model: 'glm-4.6' };
      const { deps, switchAndRetry } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
        chain: [canonical, other],
      });
      // Resolve both `sonnet` and `claude-sonnet-4-5` to the same canonical id.
      deps.resolveModelId = async (_p, m) =>
        m === 'sonnet' || m === 'claude-sonnet-4-5' ? 'claude-sonnet-4-5' : m;
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      // The canonical entry is skipped (same model as current) → switches to `other`.
      expect(switchAndRetry.mock.calls[0][1]).toEqual(other);
    });

    it('advances to the next entry when a switch fails, without bumping retryCount', async () => {
      let calls = 0;
      const { deps, switchAndRetry } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
        chain: [A, B],
        switchSucceeds: (e) => e !== A, // A fails, B succeeds
      });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      expect(switchAndRetry).toHaveBeenCalledTimes(2); // A (fail) then B (success)
      expect(switchAndRetry.mock.calls[0][1]).toEqual(A);
      expect(switchAndRetry.mock.calls[1][1]).toEqual(B);
      expect(watchdog.getState().retryCount).toBe(0); // switches are free
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

      // 1st 429 on anthropic/sonnet → switch to A.
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      expect(switchAndRetry.mock.calls[0][1]).toEqual(A);
      // setModel simulates the session now running A.
      setModel(A.provider, A.model);

      // 2nd 429 on A → switch to B.
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      expect(switchAndRetry.mock.calls[1][1]).toEqual(B);
      setModel(B.provider, B.model);

      // 3rd 429 on B → chain exhausted → cooldown (retryCount 1).
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
      // Burn the two fallback switches.
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      setModel(A.provider, A.model);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      await flush();
      setModel(B.provider, B.model);
      // Two cooldown steps allowed. Same UUID throughout (one episode);
      // clearPendingCooldown mirrors the real cooldown-retry path (cancel()
      // would start a fresh episode and reset the budget).
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(watchdog.getState().retryCount).toBe(1);
      watchdog.clearPendingCooldown();
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(watchdog.getState().retryCount).toBe(2);
      watchdog.clearPendingCooldown();
      // 3rd cooldown → exhausted → false (despite only 2 prior switchAndRetry calls).
      const result = await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      expect(result).toBe(false);
      expect(switchAndRetry).toHaveBeenCalledTimes(2);
    });

    it('a new user turn (different UUID) starts a fresh episode with a full budget', async () => {
      const { deps } = createMockDeps({ chain: [] });
      const watchdog = new RateLimitWatchdog('s', stateManager, deps, { maxAutoRetries: 1 });
      // Burn the budget on message m1.
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'x' });
      expect(watchdog.getState().retryCount).toBe(1);
      // A genuinely new user turn (m2) resets the episode — full budget back.
      const result = await watchdog.scheduleRetry('429', { uuid: 'm2', content: 'y' });
      expect(result).toBe(true);
      expect(watchdog.getState().retryCount).toBe(1); // m2's first cooldown
      watchdog.clearPendingCooldown();
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
      expect(retryCallback.mock.calls[0][1]).toBeUndefined(); // no switchTo on a cooldown retry
      expect(notifyResume).toHaveBeenCalled();
    });

    it('retryNow does NOT notify resume and reschedules when the query fails to start', async () => {
      // Manual "Retry Now" / Resume must not restore the task to in_progress if
      // the retry query can't start — it reschedules a cooldown instead so the
      // message is re-driven rather than orphaned (stuck/idle).
      const { deps, notifyResume } = createMockDeps({ chain: [] });
      const retryCallback = mock(async () => false);
      const watchdog = new RateLimitWatchdog('s', stateManager, deps);
      watchdog.setRetryCallback(retryCallback);
      await watchdog.scheduleRetry('429', { uuid: 'm1', content: 'hi' });
      // setRateLimitCooldown called once on the initial schedule.
      expect(stateManager.setRateLimitCooldown).toHaveBeenCalledTimes(1);
      const result = watchdog.retryNow();
      expect(result).toBe(true);
      await flush();
      expect(retryCallback).toHaveBeenCalledTimes(1);
      // Resume NOT notified (task stays paused)…
      expect(notifyResume).not.toHaveBeenCalled();
      // …and a bounded startup-retry timer is armed (short delay, separate
      // from the main cooldown budget) so the message is re-driven.
      expect(watchdog.isPending()).toBe(true);
      expect(watchdog.getState().status).toBe('cooldown');
      watchdog.cancel();
    });

    it('retryNow returns false during a fallback-pending switch', async () => {
      const A: FallbackModelEntry = { provider: 'glm', model: 'glm-4.6' };
      // Make switchAndRetry hang so fallbackPending stays true when we call retryNow.
      const { deps } = createMockDeps({
        current: { provider: 'anthropic', model: 'sonnet' },
        chain: [A],
      });
      // Override switchAndRetry to never resolve within the test window.
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

      // User sends a new message / resets → cancel() bumps the episode generation.
      watchdog.cancel();
      // Now let the suspended switch resolve (simulating the async teardown finishing).
      resolveSwitch(true);
      await flush();

      // The switch callback ran, but the episode was superseded: the chain did
      // NOT advance (A not marked tried) and no re-enqueue / cooldown happened.
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
      // Callback cleared: even if a retry were triggered, nothing fires.
      expect(() => watchdog.retryNow()).not.toThrow();
    });
  });
});

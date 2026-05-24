/**
 * RateLimitWatchdog Tests
 *
 * Tests for the rate limit auto-retry watchdog:
 * - Schedule retry with cooldown
 * - Cancel pending retry
 * - Max retries exceeded
 * - RetryNow bypasses cooldown
 * - Reset clears state
 * - Null message guard
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { RateLimitWatchdog } from '../../../../src/lib/agent/rate-limit-watchdog';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';

// Helper to create a mock ProcessingStateManager
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

describe('RateLimitWatchdog', () => {
  let watchdog: RateLimitWatchdog;
  let stateManager: ProcessingStateManager;
  let retryCallback: ReturnType<typeof mock>;

  beforeEach(() => {
    stateManager = createMockStateManager();
    retryCallback = mock(async () => {});
    watchdog = new RateLimitWatchdog('test-session', stateManager, {
      cooldownMs: 100, // Fast cooldown for tests
      maxAutoRetries: 3,
    });
    watchdog.setRetryCallback(retryCallback);
  });

  describe('getState', () => {
    it('returns idle state initially', () => {
      const state = watchdog.getState();
      expect(state.status).toBe('idle');
      expect(state.retryCount).toBe(0);
      expect(state.maxRetries).toBe(3);
      expect(state.retryAt).toBeNull();
      expect(state.lastUserMessage).toBeNull();
    });
  });

  describe('scheduleRetry', () => {
    it('schedules a retry and sets rate_limit_cooldown state', async () => {
      const result = await watchdog.scheduleRetry('429 rate limit', {
        uuid: 'msg-1',
        content: 'hello',
      });

      expect(result).toBe(true);
      expect(stateManager.setRateLimitCooldown).toHaveBeenCalledTimes(1);

      const state = watchdog.getState();
      expect(state.status).toBe('cooldown');
      expect(state.retryCount).toBe(1);
      expect(state.lastUserMessage).toEqual({ uuid: 'msg-1', content: 'hello' });
      expect(state.retryAt).toBeGreaterThan(Date.now() - 1000);
    });

    it('increments retryCount on subsequent calls', async () => {
      await watchdog.scheduleRetry('429', { uuid: 'msg-1', content: 'hello' });
      watchdog.cancel(); // Cancel before scheduling next

      await watchdog.scheduleRetry('429', { uuid: 'msg-2', content: 'world' });

      expect(watchdog.getState().retryCount).toBe(2);
    });

    it('returns false when max retries exceeded', async () => {
      for (let i = 0; i < 3; i++) {
        await watchdog.scheduleRetry('429', { uuid: `msg-${i}`, content: `test-${i}` });
        watchdog.cancel();
      }

      // 4th attempt should fail
      const result = await watchdog.scheduleRetry('429', { uuid: 'msg-4', content: 'nope' });
      expect(result).toBe(false);
      expect(watchdog.getState().retryCount).toBe(3);
    });

    it('returns false when lastUserMessage is null', async () => {
      const result = await watchdog.scheduleRetry('429', null);
      expect(result).toBe(false);
      expect(watchdog.getState().status).toBe('idle');
      expect(watchdog.isPending()).toBe(false);
    });

    it('fires the retry callback after cooldown', async () => {
      await watchdog.scheduleRetry('429', { uuid: 'msg-1', content: 'hello' });

      // Wait for cooldown (100ms) + buffer
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(retryCallback).toHaveBeenCalledTimes(1);
      expect(retryCallback).toHaveBeenCalledWith({ uuid: 'msg-1', content: 'hello' });
      expect(watchdog.isPending()).toBe(false);
    });
  });

  describe('cancel', () => {
    it('cancels a pending retry', async () => {
      await watchdog.scheduleRetry('429', { uuid: 'msg-1', content: 'hello' });
      expect(watchdog.isPending()).toBe(true);

      watchdog.cancel();

      expect(watchdog.isPending()).toBe(false);
      expect(watchdog.getState().status).toBe('idle');
    });

    it('does not fire callback after cancellation', async () => {
      await watchdog.scheduleRetry('429', { uuid: 'msg-1', content: 'hello' });
      watchdog.cancel();

      // Wait past cooldown
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(retryCallback).not.toHaveBeenCalled();
    });
  });

  describe('retryNow', () => {
    it('immediately fires the retry callback', async () => {
      await watchdog.scheduleRetry('429', { uuid: 'msg-1', content: 'hello' });

      const result = watchdog.retryNow();

      expect(result).toBe(true);
      expect(retryCallback).toHaveBeenCalledTimes(1);
      expect(retryCallback).toHaveBeenCalledWith({ uuid: 'msg-1', content: 'hello' });
      expect(watchdog.isPending()).toBe(false);
    });

    it('returns false if no retry is pending', () => {
      const result = watchdog.retryNow();
      expect(result).toBe(false);
    });
  });

  describe('reset', () => {
    it('clears all state', async () => {
      await watchdog.scheduleRetry('429', { uuid: 'msg-1', content: 'hello' });
      watchdog.reset();

      expect(watchdog.getState().status).toBe('idle');
      expect(watchdog.getState().retryCount).toBe(0);
      expect(watchdog.getState().lastUserMessage).toBeNull();
      expect(watchdog.isPending()).toBe(false);
    });
  });

  describe('destroy', () => {
    it('cancels timers and clears callback', async () => {
      await watchdog.scheduleRetry('429', { uuid: 'msg-1', content: 'hello' });
      watchdog.destroy();

      // Wait past cooldown
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Callback was cleared, so even though timer might have been set,
      // destroy sets retryCallback to null
      expect(retryCallback).not.toHaveBeenCalled();
    });
  });
});

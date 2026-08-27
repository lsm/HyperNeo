import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_STUCK_INITIALIZING_REFUSE_MS,
  resolveStuckInitializingGate,
  STUCK_INITIALIZING_PARK_MS,
  stuckInitializingRefuseMs,
} from '../../../../src/lib/agent/stuck-initializing-gate';

describe('stuckInitializingRefuseMs', () => {
  it('defaults to 120s when the env var is unset', () => {
    expect(stuckInitializingRefuseMs({})).toBe(DEFAULT_STUCK_INITIALIZING_REFUSE_MS);
    expect(DEFAULT_STUCK_INITIALIZING_REFUSE_MS).toBe(120_000);
  });

  it('accepts a positive override', () => {
    expect(stuckInitializingRefuseMs({ HYPERNEO_DELIVERY_STUCK_INITIALIZING_MS: '5000' })).toBe(
      5000
    );
  });

  it('falls back to the default for non-positive or non-numeric values', () => {
    expect(stuckInitializingRefuseMs({ HYPERNEO_DELIVERY_STUCK_INITIALIZING_MS: '0' })).toBe(
      DEFAULT_STUCK_INITIALIZING_REFUSE_MS
    );
    expect(stuckInitializingRefuseMs({ HYPERNEO_DELIVERY_STUCK_INITIALIZING_MS: '-5' })).toBe(
      DEFAULT_STUCK_INITIALIZING_REFUSE_MS
    );
    expect(stuckInitializingRefuseMs({ HYPERNEO_DELIVERY_STUCK_INITIALIZING_MS: 'abc' })).toBe(
      DEFAULT_STUCK_INITIALIZING_REFUSE_MS
    );
  });
});

describe('resolveStuckInitializingGate', () => {
  const baseArgs = {
    thresholdMs: 120_000,
    parkMs: STUCK_INITIALIZING_PARK_MS,
    now: 1_000_000,
  };

  it('admits when the session reports no initializing duration', () => {
    expect(resolveStuckInitializingGate({ ...baseArgs, stuckInitializingMs: null })).toEqual({
      action: 'admit',
    });
  });

  it('admits below the threshold', () => {
    expect(
      resolveStuckInitializingGate({ ...baseArgs, stuckInitializingMs: baseArgs.thresholdMs - 1 })
    ).toEqual({ action: 'admit' });
  });

  it('refuses at the threshold and schedules the park retry', () => {
    expect(
      resolveStuckInitializingGate({ ...baseArgs, stuckInitializingMs: baseArgs.thresholdMs })
    ).toEqual({
      action: 'refuse',
      initializingMs: baseArgs.thresholdMs,
      retryAt: baseArgs.now + STUCK_INITIALIZING_PARK_MS,
    });
  });
});

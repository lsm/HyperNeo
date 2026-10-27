import { describe, expect, test } from 'bun:test';
import {
  START_FAILURE_LIMIT,
  startFailureBackoffMs,
  startFailureDecision,
} from '../../../../src/lib/agent/start-failure-policy.ts';

describe('query start failure policy', () => {
  test('parks redelivery with doubling backoff capped at one minute', () => {
    expect(startFailureBackoffMs(1)).toBe(1000);
    expect(startFailureBackoffMs(2)).toBe(2000);
    expect(startFailureBackoffMs(3)).toBe(4000);
    expect(startFailureBackoffMs(10)).toBe(60_000);
  });

  test('marks the session failed after the failure limit and never parks forever before it', () => {
    for (let failures = 1; failures < START_FAILURE_LIMIT; failures++)
      expect(startFailureDecision(failures)).toEqual({
        failed: false,
        parkMs: startFailureBackoffMs(failures),
      });
    expect(startFailureDecision(START_FAILURE_LIMIT)).toEqual({ failed: true });
  });
});

import { describe, it, expect } from 'bun:test';
import {
  advanceLoopStreak,
  buildArgKey,
  decideBashDeadLoop,
  decideIdenticalArgsLoop,
  evaluateBashFailureRing,
  recordBashRingOutcome,
  stableStringify,
  summariseArgs,
} from '../../../../src/lib/agent/loop-detector-gates';

describe('stableStringify', () => {
  it('is insensitive to object key order, including nested objects', () => {
    expect(stableStringify({ a: 1, b: { x: 1, y: 2 } })).toBe(
      stableStringify({ b: { y: 2, x: 1 }, a: 1 })
    );
  });

  it('is sensitive to array element order', () => {
    expect(stableStringify({ a: [1, 2] })).not.toBe(stableStringify({ a: [2, 1] }));
  });
});

describe('buildArgKey', () => {
  it('normalises Read file_path against cwd', () => {
    expect(buildArgKey('Read', { file_path: 'foo.ts' }, '/work')).toBe(
      buildArgKey('Read', { file_path: '/work/foo.ts' }, '/work')
    );
  });

  it('leaves Read file_path untouched without cwd', () => {
    expect(buildArgKey('Read', { file_path: 'foo.ts' })).not.toBe(
      buildArgKey('Read', { file_path: './foo.ts' })
    );
  });

  it('strips description and defaults run_in_background for Bash', () => {
    expect(buildArgKey('Bash', { command: 'ls', description: 'a' }, '/w')).toBe(
      buildArgKey('Bash', { command: 'ls', description: 'b' }, '/w')
    );
    expect(buildArgKey('Bash', { command: 'ls' }, '/w')).toBe(
      buildArgKey('Bash', { command: 'ls', run_in_background: false }, '/w')
    );
  });

  it('scopes Bash fingerprints by cwd', () => {
    expect(buildArgKey('Bash', { command: 'ls' }, '/a')).not.toBe(
      buildArgKey('Bash', { command: 'ls' }, '/b')
    );
  });
});

describe('summariseArgs', () => {
  it('joins known candidates in field order and excludes path for Read', () => {
    expect(summariseArgs('Grep', { pattern: 'p', path: 'src' })).toBe('pattern=p, path=src');
    expect(summariseArgs('Read', { file_path: '/a', path: '/b' })).toBe('file_path=/a');
  });

  it('truncates Bash commands to 160 chars and falls back to JSON otherwise', () => {
    expect(summariseArgs('Bash', { command: 'x'.repeat(200) })).toBe(`command=${'x'.repeat(160)}`);
    expect(summariseArgs('WebFetch', { url: 'https://x' })).toBe('{"url":"https://x"}');
  });
});

describe('advanceLoopStreak', () => {
  const prev = {
    lastKey: 'k1',
    entry: { count: 2, firstSeenMs: 1000, lastSeenMs: 1050 },
  };

  it('continues the streak on the same key within the window', () => {
    expect(advanceLoopStreak({ prev, key: 'k1', now: 1100, windowMs: 100 })).toEqual({
      lastKey: 'k1',
      entry: { count: 3, firstSeenMs: 1000, lastSeenMs: 1100 },
    });
  });

  it('resets on a different key or an expired window', () => {
    expect(advanceLoopStreak({ prev, key: 'k2', now: 1050, windowMs: 100 }).entry.count).toBe(1);
    expect(advanceLoopStreak({ prev, key: 'k1', now: 1101, windowMs: 100 }).entry.count).toBe(1);
  });
});

describe('bash failure ring', () => {
  it('caps outcomes at failuresRequired, dropping the oldest', () => {
    let ring = recordBashRingOutcome({
      prev: undefined,
      failed: true,
      failuresRequired: 2,
      now: 1000,
      windowMs: 50,
    });
    ring = recordBashRingOutcome({
      prev: ring,
      failed: false,
      failuresRequired: 2,
      now: 1001,
      windowMs: 50,
    });
    ring = recordBashRingOutcome({
      prev: ring,
      failed: true,
      failuresRequired: 2,
      now: 1002,
      windowMs: 50,
    });
    expect(ring.outcomes).toEqual([false, true]);
  });

  it('resets a stale ring on record', () => {
    const prev = { outcomes: [true, true], lastSeenMs: 1000 };
    const ring = recordBashRingOutcome({
      prev,
      failed: false,
      failuresRequired: 5,
      now: 2000,
      windowMs: 50,
    });
    expect(ring.outcomes).toEqual([false]);
  });

  it('evaluates all-failures, mixed, empty, and expired rings', () => {
    const opts = { now: 1100, windowMs: 100 };
    expect(evaluateBashFailureRing({ ring: undefined, ...opts })).toEqual({
      allFailures: false,
      length: 0,
      expired: false,
    });
    expect(
      evaluateBashFailureRing({ ring: { outcomes: [true, true], lastSeenMs: 1050 }, ...opts })
    ).toEqual({ allFailures: true, length: 2, expired: false });
    expect(
      evaluateBashFailureRing({ ring: { outcomes: [true, false], lastSeenMs: 1050 }, ...opts })
    ).toEqual({ allFailures: false, length: 2, expired: false });
    expect(
      evaluateBashFailureRing({ ring: { outcomes: [true], lastSeenMs: 999 }, ...opts })
    ).toEqual({ allFailures: false, length: 0, expired: true });
  });
});

describe('decideIdenticalArgsLoop', () => {
  it('allows below the threshold or when untracked, denies at the threshold', () => {
    const base = { toolName: 'Read', input: { file_path: '/a' } };
    expect(decideIdenticalArgsLoop({ ...base, count: 2, threshold: 3 })).toEqual({
      action: 'allow',
    });
    expect(decideIdenticalArgsLoop({ ...base, count: 9, threshold: undefined })).toEqual({
      action: 'allow',
    });
    const denied = decideIdenticalArgsLoop({ ...base, count: 3, threshold: 3 });
    expect(denied.action).toBe('deny');
    if (denied.action === 'deny') {
      expect(denied.reason).toContain('Loop detected: Read was called 3 times');
    }
  });
});

describe('decideBashDeadLoop', () => {
  const allFailed = { allFailures: true, length: 5, expired: false };
  const base = { threshold: 5, failuresRequired: 5, input: { command: 'ls' } };

  it('allows below the streak threshold or without enough consecutive failures', () => {
    expect(decideBashDeadLoop({ ...base, count: 4, ring: allFailed })).toEqual({
      action: 'allow',
    });
    expect(
      decideBashDeadLoop({
        ...base,
        count: 6,
        ring: { allFailures: true, length: 4, expired: false },
      })
    ).toEqual({ action: 'allow' });
    expect(
      decideBashDeadLoop({
        ...base,
        count: 6,
        ring: { allFailures: false, length: 5, expired: false },
      })
    ).toEqual({ action: 'allow' });
  });

  it('denies when the streak and the failure ring both cross their thresholds', () => {
    const denied = decideBashDeadLoop({ ...base, count: 6, ring: allFailed });
    expect(denied.action).toBe('deny');
    if (denied.action === 'deny') {
      expect(denied.reason).toContain('Bash dead-loop detected');
      expect(denied.reason).toContain('last 5 attempts all failed');
    }
  });
});

import { describe, expect, test } from 'bun:test';
import { formatAddress, isAddress, parseAddress } from '../src/address.ts';

const roundTrips = [
  '@coordinator',
  '@role:task-manager',
  '@session:abc123',
  '@worker:Review',
  '@worker:Review/reviewer',
  '@worker:f1089/Review/reviewer',
  '#deployments',
];

describe('address parsing', () => {
  test('parses supported v1 address forms', () => {
    expect(parseAddress('@coordinator')).toEqual({ kind: 'handle', handle: 'coordinator' });
    expect(parseAddress('@role:task-manager')).toEqual({
      kind: 'role',
      role: 'task-manager',
    });
    expect(parseAddress('@session:abc123')).toEqual({ kind: 'session', sessionId: 'abc123' });
    expect(parseAddress('@worker:Review')).toEqual({ kind: 'worker', nodeId: 'Review' });
    expect(parseAddress('@worker:Review/reviewer')).toEqual({
      kind: 'worker',
      nodeId: 'Review',
      agentName: 'reviewer',
    });
    expect(parseAddress('@worker:f1089/Review/reviewer')).toEqual({
      kind: 'worker',
      workflowRunId: 'f1089',
      nodeId: 'Review',
      agentName: 'reviewer',
    });
    expect(parseAddress('#deployments')).toEqual({ kind: 'channel', name: 'deployments' });
  });

  test('formats parsed addresses back to target strings', () => {
    for (const target of roundTrips) {
      expect(formatAddress(parseAddress(target))).toBe(target);
    }
  });

  test('rejects unsupported or ambiguous target forms', () => {
    const invalidTargets = [
      '',
      'coordinator',
      'session:abc123',
      '@session:',
      '@role:',
      '@worker:',
      '@worker:run/node/agent/extra',
      '@worker:Review/',
      '@worker:/reviewer',
      '#',
      '##deployments',
      '@@coordinator',
      '@bad:prefix',
      '@bad/handle',
      '@ leading-space',
    ];

    for (const target of invalidTargets) {
      expect(() => parseAddress(target), target).toThrow();
      expect(isAddress(target), target).toBe(false);
    }
  });

  test('returns true for supported address strings', () => {
    for (const target of roundTrips) {
      expect(isAddress(target), target).toBe(true);
    }
  });

  test('rejects malformed formatted address parts', () => {
    expect(() => formatAddress({ kind: 'handle', handle: '@coordinator' })).toThrow(
      "Handle address cannot contain '@', ':', or '/'"
    );
    expect(() => formatAddress({ kind: 'channel', name: '#deployments' })).toThrow(
      'Channel address cannot contain extra # prefix'
    );
    expect(() =>
      formatAddress({ kind: 'worker', workflowRunId: 'f1089', nodeId: 'Review' })
    ).toThrow('Address worker agent cannot be empty');
  });
});

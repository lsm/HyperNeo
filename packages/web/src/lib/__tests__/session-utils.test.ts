import { describe, it, expect } from 'vitest';
import { getModelLabel, isUserSession } from '../session-utils';
import type { Session } from '@hyperneo/shared';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-id',
    title: 'Test Session',
    workspacePath: '/tmp/test',
    status: 'active',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      totalCost: 0,
    },
    config: {
      model: 'sonnet',
    },
    ...overrides,
  } as Session;
}

describe('getModelLabel', () => {
  it('formats Moonshot model IDs', () => {
    expect(getModelLabel('moonshot-v1-32k')).toBe('Moonshot v1 32k');
    expect(getModelLabel('moonshot-v1-128k')).toBe('Moonshot v1 128k');
  });

  it('formats Kimi model IDs', () => {
    expect(getModelLabel('kimi-for-coding')).toBe('Kimi for coding');
    expect(getModelLabel('kimi-k3')).toBe('Kimi K3');
    expect(getModelLabel('kimi-k2.7-code')).toBe('Kimi K2.7 Code');
    expect(getModelLabel('kimi-k2.7-code-highspeed')).toBe('Kimi K2.7 Code Highspeed');
  });
});

describe('isUserSession', () => {
  it('should return true for worker sessions', () => {
    const session = makeSession({ type: 'worker' });
    expect(isUserSession(session)).toBe(true);
  });

  it('should return true for sessions without type (legacy)', () => {
    const session = makeSession({ type: undefined });
    expect(isUserSession(session)).toBe(true);
  });

  it('should return false for lobby sessions', () => {
    const session = makeSession({ type: 'lobby' });
    expect(isUserSession(session)).toBe(false);
  });

  it('should return true for worker sessions without context', () => {
    const session = makeSession({ type: 'worker', context: undefined });
    expect(isUserSession(session)).toBe(true);
  });

  it('should return true for worker sessions with empty context', () => {
    const session = makeSession({ type: 'worker', context: {} });
    expect(isUserSession(session)).toBe(true);
  });
});

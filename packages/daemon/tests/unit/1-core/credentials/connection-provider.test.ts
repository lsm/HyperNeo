import { describe, expect, test } from 'bun:test';
import { connectionProviders, connectionStatus } from '../../../../src/lib/connections/status.ts';

const record = {
  id: 'connection-1',
  accountId: 'account-1',
  email: 'person@example.com',
  scopes: ['openid'],
  health: 'healthy',
};

describe('connectionStatus', () => {
  test('accepts every registered provider', () => {
    expect(connectionProviders).toContain('google');
    for (const provider of connectionProviders)
      expect(connectionStatus.parse({ ...record, provider }).provider).toBe(provider);
  });

  test('rejects a provider outside the registry', () => {
    expect(connectionStatus.safeParse({ ...record, provider: 'unknown' }).success).toBe(false);
  });
});

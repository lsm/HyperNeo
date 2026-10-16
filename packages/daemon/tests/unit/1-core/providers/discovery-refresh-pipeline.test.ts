import { describe, expect, it } from 'bun:test';
import {
  credentialIdentity,
  stripPersistedDiscovery,
} from '../../../../src/lib/providers/discovery-refresh-pipeline';

describe('discovery-refresh pipeline helpers', () => {
  describe('stripPersistedDiscovery', () => {
    it('removes the discoveredModels wrapper and keeps other keys', () => {
      const stripped = stripPersistedDiscovery(
        JSON.stringify({ command: 'x', discoveredModels: { models: [{ id: 'a' }] } })
      );
      expect(JSON.parse(stripped!)).toEqual({ command: 'x' });
    });

    it('returns invalid or wrapper-free config unchanged', () => {
      expect(stripPersistedDiscovery('not json')).toBe('not json');
      expect(stripPersistedDiscovery(JSON.stringify([1]))).toBe(JSON.stringify([1]));
      expect(stripPersistedDiscovery(JSON.stringify({ command: 'x' }))).toBe(
        JSON.stringify({ command: 'x' })
      );
      expect(stripPersistedDiscovery(undefined)).toBeUndefined();
    });
  });

  describe('credentialIdentity', () => {
    it('snapshots null, api keys, and volatility-stable oauth identities', () => {
      expect(credentialIdentity(null)).toBe('null');
      expect(credentialIdentity(undefined)).toBe('null');
      expect(credentialIdentity({ type: 'api_key', apiKey: 'a' })).not.toBe(
        credentialIdentity({ type: 'api_key', apiKey: 'b' })
      );
      expect(
        credentialIdentity({ type: 'oauth', accessToken: 'volatile', refreshToken: 'r' })
      ).toBe(credentialIdentity({ type: 'oauth', accessToken: 'other', refreshToken: 'r' }));
      expect(credentialIdentity({ type: 'oauth', accessToken: 'a' })).not.toBe(
        credentialIdentity({ type: 'oauth', accessToken: 'b' })
      );
    });
  });
});

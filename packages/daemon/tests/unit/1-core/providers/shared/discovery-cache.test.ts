import { describe, expect, it } from 'bun:test';
import type { ModelInfo } from '@hyperneo/shared';
import {
  mergeDiscoveredModels,
  PROVIDER_DISCOVERY_CACHE_TTL_MS,
  ProviderDiscoveryCache,
  providerDiscoveryFingerprint,
} from '../../../../../src/lib/providers/shared/discovery-cache';

function model(id: string, provider = 'kimi'): ModelInfo {
  return {
    id,
    name: id,
    alias: id,
    family: provider,
    provider,
    contextWindow: 1000,
    description: id,
    releaseDate: '',
    available: true,
  };
}

describe('providerDiscoveryFingerprint', () => {
  it('is stable for identical effective configuration', () => {
    const a = providerDiscoveryFingerprint({
      region: 'china',
      baseUrl: 'https://api.kimi.com/coding/v1',
      credentialKey: 'secret-key',
    });
    const b = providerDiscoveryFingerprint({
      region: 'china',
      baseUrl: 'https://api.kimi.com/coding/v1',
      credentialKey: 'secret-key',
    });
    expect(a).toBe(b);
  });

  it('changes when region, base URL, command, or credential identity changes', () => {
    const base = {
      region: 'china',
      baseUrl: 'https://api.kimi.com/coding/v1',
      command: 'agent',
      credentialKey: 'secret-key',
    };
    const baseFingerprint = providerDiscoveryFingerprint(base);
    expect(providerDiscoveryFingerprint({ ...base, region: 'global' })).not.toBe(baseFingerprint);
    expect(
      providerDiscoveryFingerprint({ ...base, baseUrl: 'https://api.moonshot.ai/v1' })
    ).not.toBe(baseFingerprint);
    expect(providerDiscoveryFingerprint({ ...base, command: 'other-agent' })).not.toBe(
      baseFingerprint
    );
    expect(providerDiscoveryFingerprint({ ...base, credentialKey: 'other-key' })).not.toBe(
      baseFingerprint
    );
  });

  it('does not embed the raw credential in the fingerprint', () => {
    const fingerprint = providerDiscoveryFingerprint({ credentialKey: 'super-secret-key' });
    expect(fingerprint).not.toContain('super-secret-key');
  });

  it('treats a missing credential distinctly from any credential', () => {
    expect(providerDiscoveryFingerprint({})).not.toBe(
      providerDiscoveryFingerprint({ credentialKey: 'k' })
    );
  });
});

describe('ProviderDiscoveryCache', () => {
  it('returns null when empty', () => {
    const cache = new ProviderDiscoveryCache();
    expect(cache.get('fp')).toBeNull();
  });

  it('serves models within the TTL for a matching fingerprint', () => {
    const cache = new ProviderDiscoveryCache();
    const models = [model('a')];
    cache.set('fp', models, 1000);
    expect(cache.get('fp', 1000 + PROVIDER_DISCOVERY_CACHE_TTL_MS - 1)).toBe(models);
  });

  it('expires entries after the TTL so callers refetch', () => {
    const cache = new ProviderDiscoveryCache();
    cache.set('fp', [model('a')], 1000);
    expect(cache.get('fp', 1000 + PROVIDER_DISCOVERY_CACHE_TTL_MS)).toBeNull();
  });

  it('invalidates entries when the configuration fingerprint changes', () => {
    const cache = new ProviderDiscoveryCache();
    cache.set('fp-china', [model('a')], 1000);
    expect(cache.get('fp-global', 1001)).toBeNull();
  });

  it('replaces the previous entry on set', () => {
    const cache = new ProviderDiscoveryCache();
    cache.set('fp-old', [model('a')], 1000);
    cache.set('fp-new', [model('b')], 2000);
    expect(cache.get('fp-old', 2001)).toBeNull();
    expect(cache.get('fp-new', 2001)?.[0]?.id).toBe('b');
  });

  it('clear drops the entry', () => {
    const cache = new ProviderDiscoveryCache();
    cache.set('fp', [model('a')], 1000);
    cache.clear();
    expect(cache.get('fp', 1001)).toBeNull();
  });
});

describe('mergeDiscoveredModels', () => {
  it('keeps static entries first in static order and appends discovered-only ids', () => {
    const staticModels = [model('s1'), model('s2')];
    const discovered = [model('d1'), model('d2')];
    expect(mergeDiscoveredModels(staticModels, discovered).map((m) => m.id)).toEqual([
      's1',
      's2',
      'd1',
      'd2',
    ]);
  });

  it('lets a discovered entry replace the same-id static entry in place', () => {
    const staticModels = [model('s1'), model('s2')];
    const refreshed = { ...model('s1'), name: 'S1 refreshed' };
    const merged = mergeDiscoveredModels(staticModels, [refreshed]);
    expect(merged.map((m) => m.id)).toEqual(['s1', 's2']);
    expect(merged[0]?.name).toBe('S1 refreshed');
  });

  it('dedupes repeated discovered ids, keeping the last', () => {
    const merged = mergeDiscoveredModels([], [model('d'), { ...model('d'), name: 'newer' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.name).toBe('newer');
  });
});

import type { ModelInfo } from '@hyperneo/shared';

export const PROVIDER_DISCOVERY_CACHE_TTL_MS = 5 * 60_000;

export interface ProviderDiscoveryFingerprintParts {
  region?: string;
  baseUrl?: string;
  command?: string;
  credentialKey?: string;
}

function hashCredentialIdentity(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export function providerDiscoveryFingerprint(parts: ProviderDiscoveryFingerprintParts): string {
  return JSON.stringify([
    parts.region ?? '',
    parts.baseUrl ?? '',
    parts.command ?? '',
    parts.credentialKey ? hashCredentialIdentity(parts.credentialKey) : '',
  ]);
}

interface ProviderDiscoveryCacheEntry {
  fingerprint: string;
  models: ModelInfo[];
  fetchedAt: number;
}

export class ProviderDiscoveryCache {
  private entry: ProviderDiscoveryCacheEntry | null = null;

  constructor(private readonly ttlMs = PROVIDER_DISCOVERY_CACHE_TTL_MS) {}

  get(fingerprint: string, now: number = Date.now()): ModelInfo[] | null {
    const entry = this.entry;
    if (!entry || entry.fingerprint !== fingerprint) return null;
    if (now - entry.fetchedAt >= this.ttlMs) return null;
    return entry.models;
  }

  set(fingerprint: string, models: ModelInfo[], now: number = Date.now()): void {
    this.entry = { fingerprint, models, fetchedAt: now };
  }

  clear(): void {
    this.entry = null;
  }
}

export function mergeDiscoveredModels(
  staticModels: readonly ModelInfo[],
  discovered: readonly ModelInfo[]
): ModelInfo[] {
  const merged = new Map<string, ModelInfo>();
  for (const model of staticModels) {
    merged.set(model.id, model);
  }
  for (const model of discovered) {
    merged.set(model.id, model);
  }
  return Array.from(merged.values());
}

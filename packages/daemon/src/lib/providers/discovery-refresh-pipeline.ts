import type { ProviderCredentials } from '@hyperneo/shared/provider';

const LAST_GOOD_DISCOVERY_KEY = 'discoveredModels';

export { PROVIDER_MODEL_LOAD_TIMEOUT_MS } from '@hyperneo/shared/provider';

export function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Provider discovery timed out')), ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function credentialIdentity(credentials: ProviderCredentials | null | undefined): string {
  if (!credentials) return 'null';
  if (credentials.type === 'api_key') {
    return JSON.stringify({ type: 'api_key', apiKey: credentials.apiKey });
  }
  return JSON.stringify({
    type: 'oauth',
    refreshToken: credentials.refreshToken ?? null,
    ...(credentials.refreshToken === undefined ? { accessToken: credentials.accessToken } : {}),
  });
}

export function stripPersistedDiscovery(configJson: string | undefined): string | undefined {
  if (!configJson) return configJson;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(configJson) as Record<string, unknown>;
  } catch {
    return configJson;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return configJson;
  if (!(LAST_GOOD_DISCOVERY_KEY in parsed)) return configJson;
  delete parsed[LAST_GOOD_DISCOVERY_KEY];
  return JSON.stringify(parsed);
}

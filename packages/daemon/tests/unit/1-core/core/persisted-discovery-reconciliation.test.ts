import { afterEach, describe, expect, test } from 'bun:test';
import type { Provider, ProviderCredentials } from '@hyperneo/shared/provider';
import { applyStoredProviderCredentials } from '../../../../src/app';
import {
  KeychainUnavailableError,
  type CredentialStore,
} from '../../../../src/lib/credentials/credential-store';
import { ProviderCredentialManager } from '../../../../src/lib/credentials/provider-credential-manager';
import { ProviderRepository } from '../../../../src/storage/repositories/provider-repository';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { createTables } from '../../../../src/storage/schema/index';
import { Database as SqliteDatabase } from '../../../../src/storage/sqlite-compat';
import type { Database } from '../../../../src/storage/database';

const DISCOVERY_CONFIG = JSON.stringify({
  discoveredModels: { models: [{ id: 'model-a' }] },
  otherSetting: true,
});
const STRIPPED_CONFIG = JSON.stringify({ otherSetting: true });

function apiKey(key: string): ProviderCredentials {
  return { type: 'api_key', apiKey: key };
}

function oauth(accessToken: string, refreshToken?: string): ProviderCredentials {
  return { type: 'oauth', accessToken, refreshToken };
}

interface ScenarioOptions {
  providerCredentials: ProviderCredentials | null;
  stored?: ProviderCredentials;
  env?: Record<string, string>;
  configJson?: string;
  withRow?: boolean;
  store?: CredentialStore;
}

const openDatabases: SqliteDatabase[] = [];

async function runScenario(options: ScenarioOptions) {
  const db = new SqliteDatabase(':memory:');
  openDatabases.push(db);
  const providerId = 'anthropic';
  createTables(db);
  const reactiveDb = createReactiveDatabase({
    getDatabase: () => db,
  } as unknown as Database);
  const providers = new ProviderRepository(db, reactiveDb);
  if (options.withRow !== false) {
    providers.createProvider({
      providerId: providerId,
      displayName: 'Anthropic',
      kind: 'built_in',
      authType: 'api_key',
      configJson: options.configJson,
    });
  }
  const credentialManager = options.store
    ? new ProviderCredentialManager(options.store, db, options.env ?? {})
    : ProviderCredentialManager.create(db, options.env ?? {});
  if (options.stored) {
    await (options.stored.type === 'api_key'
      ? credentialManager.storeApiKey(providerId, options.stored.apiKey)
      : credentialManager.storeOAuthTokens(providerId, options.stored));
  }
  const assigned: ProviderCredentials[] = [];
  const errors: unknown[][] = [];
  const provider = {
    id: providerId,
    getCredentials: async () => options.providerCredentials,
    setCredentials: (credentials: ProviderCredentials) => assigned.push(credentials),
  } as unknown as Provider;
  await applyStoredProviderCredentials(
    [provider],
    credentialManager,
    { providers },
    (...args: unknown[]) => errors.push(args)
  );
  return {
    configJson: () => providers.getProviderByProviderId(providerId)?.configJson,
    healthStatus: () => providers.getProviderByProviderId(providerId)?.healthStatus,
    stored: () => credentialManager.getCredentials(providerId),
    assigned,
    errors,
  };
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

describe('startup persisted-discovery reconciliation', () => {
  test('strips when nothing is stored, discovery is persisted, and env has no credentials', async () => {
    const result = await runScenario({
      providerCredentials: apiKey('sk-live'),
      configJson: DISCOVERY_CONFIG,
    });
    expect(result.configJson()).toBe(STRIPPED_CONFIG);
    expect(await result.stored()).toEqual(apiKey('sk-live'));
  });

  test('keeps discovery when env credentials are present and nothing is stored', async () => {
    const result = await runScenario({
      providerCredentials: apiKey('sk-env'),
      env: { ANTHROPIC_API_KEY: 'sk-env' },
      configJson: DISCOVERY_CONFIG,
    });
    expect(result.configJson()).toBe(DISCOVERY_CONFIG);
  });

  test('keeps discovery when stored credentials match the provider identity', async () => {
    const result = await runScenario({
      providerCredentials: apiKey('sk-live'),
      stored: apiKey('sk-live'),
      configJson: DISCOVERY_CONFIG,
    });
    expect(result.configJson()).toBe(DISCOVERY_CONFIG);
  });

  test('strips when stored credentials differ from the provider identity', async () => {
    const result = await runScenario({
      providerCredentials: apiKey('sk-live'),
      stored: apiKey('sk-old-account'),
      configJson: DISCOVERY_CONFIG,
    });
    expect(result.configJson()).toBe(STRIPPED_CONFIG);
  });

  test('oauth: strips when the access token changed, keeps when both tokens match', async () => {
    const stripped = await runScenario({
      providerCredentials: oauth('access-b', 'refresh-r'),
      stored: oauth('access-a', 'refresh-r'),
      configJson: DISCOVERY_CONFIG,
    });
    expect(stripped.configJson()).toBe(STRIPPED_CONFIG);

    const kept = await runScenario({
      providerCredentials: oauth('access-a', 'refresh-r'),
      stored: oauth('access-a', 'refresh-r'),
      configJson: DISCOVERY_CONFIG,
    });
    expect(kept.configJson()).toBe(DISCOVERY_CONFIG);
  });

  test('no row write when identity changed but configJson has nothing strippable', async () => {
    const withoutDiscovery = await runScenario({
      providerCredentials: apiKey('sk-live'),
      stored: apiKey('sk-old-account'),
      configJson: JSON.stringify({ command: 'ollama' }),
    });
    expect(withoutDiscovery.configJson()).toBe(JSON.stringify({ command: 'ollama' }));

    const malformed = await runScenario({
      providerCredentials: apiKey('sk-live'),
      stored: apiKey('sk-old-account'),
      configJson: 'not json',
    });
    expect(malformed.configJson()).toBe('not json');
  });

  test('runs clean without a provider row and stores the provider credentials', async () => {
    const result = await runScenario({
      providerCredentials: apiKey('sk-live'),
      stored: apiKey('sk-old-account'),
      withRow: false,
    });
    expect(await result.stored()).toEqual(apiKey('sk-live'));
  });

  test('skips reconciliation for providers without own credentials and loads stored ones', async () => {
    const result = await runScenario({
      providerCredentials: null,
      stored: apiKey('sk-stored'),
      configJson: DISCOVERY_CONFIG,
    });
    expect(result.configJson()).toBe(DISCOVERY_CONFIG);
    expect(result.assigned).toEqual([apiKey('sk-stored')]);
  });

  test('malformed stored credentials: treats them as absent, strips, and still repairs the store', async () => {
    let storedData: string | null = 'not json';
    const result = await runScenario({
      providerCredentials: apiKey('sk-live'),
      configJson: DISCOVERY_CONFIG,
      store: {
        get: async () => storedData,
        set: async (_service, _account, data) => {
          storedData = data;
        },
        delete: async () => {
          storedData = null;
        },
        listServices: async () => [],
      },
    });
    expect(result.configJson()).toBe(STRIPPED_CONFIG);
    expect(await result.stored()).toEqual(apiKey('sk-live'));
    expect(result.healthStatus()).toBe('healthy');
  });

  test('keychain-unavailable store: continues without stripping or marking unhealthy', async () => {
    const result = await runScenario({
      providerCredentials: apiKey('sk-live'),
      configJson: DISCOVERY_CONFIG,
      store: {
        get: () => Promise.reject(new KeychainUnavailableError('locked')),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        listServices: () => Promise.resolve([]),
      },
    });
    expect(result.configJson()).toBe(DISCOVERY_CONFIG);
    expect(result.healthStatus()).toBe('unknown');
    expect(result.errors).toHaveLength(0);
  });
});

/**
 * Tests for Provider RPC handlers.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import { setupProviderHandlers } from '../../../../src/lib/rpc-handlers/provider-handlers';
import { getProviderRegistry, resetProviderRegistry } from '../../../../src/lib/providers/registry';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';
import type { ProviderRepository } from '../../../../src/storage/repositories/provider-repository';
import type { ProviderCredentialManager } from '../../../../src/lib/credentials/provider-credential-manager';
import type { ProviderRecord, CreateProviderParams } from '@neokai/shared';
import type { Provider } from '@neokai/shared/provider';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
  const handlers = new Map<string, RequestHandler>();
  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
  } as unknown as MessageHub;
  return { hub, handlers };
}

function createMockProviderRepo(): ProviderRepository {
  const records = new Map<string, ProviderRecord>();
  let nextId = 1;

  return {
    listProviders: () => Array.from(records.values()).sort((a, b) => a.sortOrder - b.sortOrder),
    listEnabledProviders: () =>
      Array.from(records.values())
        .filter((r) => r.isEnabled)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    getProvider: (id: string) => records.get(id) ?? null,
    getProviderByProviderId: (providerId: string) =>
      Array.from(records.values()).find((r) => r.providerId === providerId) ?? null,
    isProviderIdTaken: (providerId: string) =>
      Array.from(records.values()).some((r) => r.providerId === providerId),
    createProvider: (params: CreateProviderParams) => {
      const id = String(nextId++);
      const now = Date.now();
      const record: ProviderRecord = {
        id,
        providerId: params.providerId,
        displayName: params.displayName,
        kind: params.kind,
        authType: params.authType,
        isEnabled: params.isEnabled ?? true,
        isDefault: params.isDefault ?? false,
        sortOrder: params.sortOrder ?? 0,
        baseUrl: params.baseUrl,
        configJson: params.configJson,
        customEndpointConfigJson: params.customEndpointConfigJson,
        healthStatus: 'unknown',
        createdAt: now,
        updatedAt: now,
      };
      records.set(id, record);
      return record;
    },
    updateProvider: (id: string, params) => {
      const existing = records.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...params, updatedAt: Date.now() };
      records.set(id, updated);
      return updated;
    },
    deleteProvider: (id: string) => {
      return records.delete(id);
    },
    setDefaultProvider: (id: string) => {
      for (const r of records.values()) {
        r.isDefault = r.id === id;
      }
    },
    countProviders: () => records.size,
  } as unknown as ProviderRepository;
}

function createMockCredentialManager(): ProviderCredentialManager {
  const store = new Map<string, string>();
  return {
    storeApiKey: mock(async (providerId: string, apiKey: string) => {
      store.set(providerId, apiKey);
    }),
    storeOAuthTokens: mock(async (providerId: string, tokens: object) => {
      store.set(providerId, JSON.stringify(tokens));
    }),
    getCredentials: mock(async (providerId: string) => {
      const raw = store.get(providerId);
      return raw ? { apiKey: raw } : null;
    }),
    removeCredentials: mock(async (providerId: string) => {
      store.delete(providerId);
    }),
    migrateFromEnv: mock(async () => false),
  } as unknown as ProviderCredentialManager;
}

describe('Provider RPC handlers', () => {
  let hubData: ReturnType<typeof createMockMessageHub>;
  let repo: ReturnType<typeof createMockProviderRepo>;
  let creds: ReturnType<typeof createMockCredentialManager>;

  beforeEach(() => {
    hubData = createMockMessageHub();
    repo = createMockProviderRepo();
    creds = createMockCredentialManager();
    resetProviderRegistry();
    resetProviderFactory();
  });

  afterEach(() => {
    resetProviderRegistry();
    resetProviderFactory();
  });

  function setup(): Map<string, RequestHandler> {
    setupProviderHandlers({
      messageHub: hubData.hub,
      providerRepo: repo,
      credentialManager: creds,
    });
    return hubData.handlers;
  }

  describe('providers.list', () => {
    it('returns empty array when no providers', async () => {
      const handlers = setup();
      const result = (await handlers.get('providers.list')!({}, {})) as {
        providers: ProviderRecord[];
      };
      expect(result.providers).toEqual([]);
    });

    it('returns providers with availability', async () => {
      repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      const handlers = setup();
      const result = (await handlers.get('providers.list')!({}, {})) as {
        providers: Array<ProviderRecord & { available: boolean }>;
      };
      expect(result.providers.length).toBe(1);
      expect(result.providers[0].providerId).toBe('anthropic');
    });
  });

  describe('providers.create', () => {
    it('creates a provider and stores credentials', async () => {
      const handlers = setup();
      const result = (await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'openrouter',
            displayName: 'OpenRouter',
            kind: 'built_in',
            authType: 'api_key',
          },
          credentials: { apiKey: 'sk-or-test' },
        },
        {}
      )) as { success: boolean; provider: ProviderRecord };

      expect(result.success).toBe(true);
      expect(result.provider.providerId).toBe('openrouter');
      expect(creds.storeApiKey).toHaveBeenCalledWith('openrouter', 'sk-or-test');
    });

    it('rejects invalid kind', async () => {
      const handlers = setup();
      await expect(
        handlers.get('providers.create')!(
          {
            params: {
              providerId: 'x',
              displayName: 'X',
              kind: 'invalid',
              authType: 'api_key',
            },
          },
          {}
        )
      ).rejects.toThrow('kind must be one of');
    });
  });

  describe('providers.update', () => {
    it('updates display name', async () => {
      const created = repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      const handlers = setup();
      const result = (await handlers.get('providers.update')!(
        { id: created.id, params: { displayName: 'Anthropic Inc' } },
        {}
      )) as { success: boolean; provider: ProviderRecord };

      expect(result.success).toBe(true);
      expect(result.provider.displayName).toBe('Anthropic Inc');
    });
  });

  describe('providers.delete', () => {
    it('deletes a provider', async () => {
      const created = repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      const handlers = setup();
      const result = (await handlers.get('providers.delete')!({ id: created.id }, {})) as {
        success: boolean;
      };

      expect(result.success).toBe(true);
      expect(repo.getProvider(created.id)).toBeNull();
    });

    it('throws when provider not found', async () => {
      const handlers = setup();
      await expect(handlers.get('providers.delete')!({ id: 'missing' }, {})).rejects.toThrow(
        'not found'
      );
    });
  });

  describe('providers.setDefault', () => {
    it('sets default provider', async () => {
      const a = repo.createProvider({
        providerId: 'a',
        displayName: 'A',
        kind: 'built_in',
        authType: 'none',
      });
      const b = repo.createProvider({
        providerId: 'b',
        displayName: 'B',
        kind: 'built_in',
        authType: 'none',
      });
      const handlers = setup();

      await handlers.get('providers.setDefault')!({ id: b.id }, {});
      expect(repo.getProvider(a.id)?.isDefault).toBe(false);
      expect(repo.getProvider(b.id)?.isDefault).toBe(true);
    });
  });

  describe('providers.test', () => {
    it('returns healthy for available provider', async () => {
      repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      const registry = getProviderRegistry();
      registry.register({
        id: 'anthropic',
        displayName: 'Anthropic',
        capabilities: {
          streaming: true,
          extendedThinking: true,
          thinkingModes: 'granular',
          maxContextWindow: 200000,
          functionCalling: true,
          vision: true,
        },
        isAvailable: () => true,
        getModels: async () => [],
        ownsModel: () => true,
        getModelForTier: () => 'sonnet',
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
      } as Provider);

      const handlers = setup();
      const result = (await handlers.get('providers.test')!(
        { id: repo.listProviders()[0].id },
        {}
      )) as {
        healthy: boolean;
      };

      expect(result.healthy).toBe(true);
    });

    it('returns unhealthy for missing provider', async () => {
      const created = repo.createProvider({
        providerId: 'missing',
        displayName: 'Missing',
        kind: 'built_in',
        authType: 'api_key',
      });
      const handlers = setup();
      const result = (await handlers.get('providers.test')!({ id: created.id }, {})) as {
        healthy: boolean;
        error: string;
      };

      expect(result.healthy).toBe(false);
    });
  });
});

/**
 * Tests for Provider RPC handlers.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import { setupProviderHandlers } from '../../../../src/lib/rpc-handlers/provider-handlers';
import { getProviderRegistry, resetProviderRegistry } from '../../../../src/lib/providers/registry';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';
import type { ProviderRepository } from '../../../../src/storage/repositories/provider-repository';
import type { ProviderCredentialManager } from '../../../../src/lib/credentials/provider-credential-manager';
import { KeychainUnavailableError } from '../../../../src/lib/credentials/credential-store';
import type { ProviderRecord, CreateProviderParams } from '@hyperneo/shared';
import type { Provider } from '@hyperneo/shared/provider';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockInternalEventBus(): InternalEventBus<DaemonInternalEventMap> {
  return {
    publishAsync: mock(() => {}),
    publish: mock(async () => ({ delivered: 0, failures: [] })),
    subscribe: mock(() => () => {}),
    off: mock(() => {}),
    clear: mock(() => {}),
    getHandlerCount: mock(() => 0),
    getHandlerCountForSession: mock(() => 0),
    getHandlerCountForNamespace: mock(() => 0),
  } as unknown as InternalEventBus<DaemonInternalEventMap>;
}

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
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed.accessToken !== undefined) {
          return { type: 'oauth' as const, accessToken: parsed.accessToken };
        }
      } catch {
        // not JSON, treat as api key
      }
      return { type: 'api_key' as const, apiKey: raw };
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
  let eventBus: ReturnType<typeof createMockInternalEventBus>;

  beforeEach(() => {
    hubData = createMockMessageHub();
    repo = createMockProviderRepo();
    creds = createMockCredentialManager();
    eventBus = createMockInternalEventBus();
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
      internalEventBus: eventBus,
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

    it('does not store custom_endpoint credentials in the credential store', async () => {
      // Custom endpoints keep auth inline in customEndpointConfigJson. The
      // credential store must be skipped so a locked macOS Keychain cannot
      // block creating the endpoint.
      const handlers = setup();
      const result = (await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'custom:lm',
            displayName: 'LM Studio',
            kind: 'custom_endpoint',
            authType: 'api_key',
          },
          credentials: { apiKey: 'inline-key' },
        },
        {}
      )) as { success: boolean; provider: ProviderRecord };

      expect(result.success).toBe(true);
      expect(creds.storeApiKey).not.toHaveBeenCalled();
    });

    it('rolls back the provider row and surfaces keychain guidance when storeApiKey throws KeychainUnavailableError', async () => {
      // Built-in providers persist secrets in the macOS Keychain. If the
      // Keychain is locked, the create must (a) reject with an actionable
      // message the UI can toast, (b) remove the just-inserted provider row
      // so retries don't see 'already exists', and (c) skip the
      // providers.changed broadcast.
      creds.storeApiKey = mock(async () => {
        throw new KeychainUnavailableError('User interaction is not allowed.');
      });
      const handlers = setup();

      await expect(
        handlers.get('providers.create')!(
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
        )
      ).rejects.toThrow('macOS Keychain is locked or unavailable');

      // Compensating delete happened.
      expect(repo.listProviders()).toEqual([]);
      // Broadcast skipped because nothing changed from the user's perspective.
      expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });

    it('re-registers a built-in provider that was previously unregistered', async () => {
      // Simulate deleting and re-adding a built-in provider
      const registry = getProviderRegistry();
      registry.unregister('anthropic-codex');
      expect(registry.has('anthropic-codex')).toBe(false);

      const handlers = setup();
      const result = (await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'anthropic-codex',
            displayName: 'OpenAI (Codex)',
            kind: 'built_in',
            authType: 'oauth',
          },
        },
        {}
      )) as { success: boolean; provider: ProviderRecord };

      expect(result.success).toBe(true);
      expect(registry.has('anthropic-codex')).toBe(true);
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

    it('emits providers.changed after creation', async () => {
      const handlers = setup();
      await handlers.get('providers.create')!(
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
      );
      expect(eventBus.publishAsync).toHaveBeenCalledWith('providers.changed', {
        sessionId: 'global',
      });
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

    it('emits providers.changed after update', async () => {
      const created = repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      const handlers = setup();
      await handlers.get('providers.update')!(
        { id: created.id, params: { displayName: 'Anthropic Inc' } },
        {}
      );
      expect(eventBus.publishAsync).toHaveBeenCalledWith('providers.changed', {
        sessionId: 'global',
      });
    });
  });

  describe('providers.delete', () => {
    it('disables a built-in provider instead of deleting the row', async () => {
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
      const after = repo.getProvider(created.id);
      expect(after).not.toBeNull();
      expect(after?.isEnabled).toBe(false);
    });

    it('throws when provider not found', async () => {
      const handlers = setup();
      await expect(handlers.get('providers.delete')!({ id: 'missing' }, {})).rejects.toThrow(
        'not found'
      );
    });

    it('emits providers.changed after deletion', async () => {
      const created = repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      const handlers = setup();
      await handlers.get('providers.delete')!({ id: created.id }, {});
      expect(eventBus.publishAsync).toHaveBeenCalledWith('providers.changed', {
        sessionId: 'global',
      });
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

  describe('providers.create', () => {
    it('creates a provider and stores apiKey credentials', async () => {
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

    it('creates a provider and stores OAuth credentials', async () => {
      const handlers = setup();
      const result = (await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'anthropic-codex',
            displayName: 'OpenAI (Codex)',
            kind: 'built_in',
            authType: 'oauth',
          },
          credentials: {
            oauthAccessToken: 'tok-test',
            oauthRefreshToken: 'ref-test',
            oauthExpiresAt: 12345678,
          },
        },
        {}
      )) as { success: boolean; provider: ProviderRecord };

      expect(result.success).toBe(true);
      expect(creds.storeOAuthTokens).toHaveBeenCalledWith('anthropic-codex', {
        accessToken: 'tok-test',
        refreshToken: 'ref-test',
        expiresAt: 12345678,
      });
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

  describe('providers.get', () => {
    it('returns a provider by id with availability', async () => {
      const created = repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      const handlers = setup();
      const result = (await handlers.get('providers.get')!({ id: created.id }, {})) as {
        provider: ProviderRecord & { available: boolean };
      };

      expect(result.provider.providerId).toBe('anthropic');
      expect(result.provider.available).toBe(false);
    });

    it('throws when provider not found', async () => {
      const handlers = setup();
      await expect(handlers.get('providers.get')!({ id: 'missing' }, {})).rejects.toThrow(
        'not found'
      );
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

    it('updates OAuth credentials', async () => {
      const created = repo.createProvider({
        providerId: 'anthropic-codex',
        displayName: 'OpenAI (Codex)',
        kind: 'built_in',
        authType: 'none',
      });
      const handlers = setup();
      const result = (await handlers.get('providers.update')!(
        {
          id: created.id,
          params: {},
          credentials: {
            oauthAccessToken: 'new-tok',
            oauthRefreshToken: 'new-ref',
            oauthExpiresAt: 87654321,
          },
        },
        {}
      )) as { success: boolean; provider: ProviderRecord };

      expect(result.success).toBe(true);
      expect(result.provider.authType).toBe('oauth');
      expect(creds.storeOAuthTokens).toHaveBeenCalledWith('anthropic-codex', {
        accessToken: 'new-tok',
        refreshToken: 'new-ref',
        expiresAt: 87654321,
      });
    });

    it('surfaces keychain guidance and leaves the record untouched when storeApiKey throws KeychainUnavailableError', async () => {
      // If the credential write fails because the macOS Keychain is locked,
      // the update must reject with an actionable message and must NOT flip
      // authType or otherwise advance the DB row — the record should stay in
      // its pre-update state so the user can retry after unlocking Keychain.
      const created = repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'none',
      });
      creds.storeApiKey = mock(async () => {
        throw new KeychainUnavailableError('User interaction is not allowed.');
      });
      const handlers = setup();

      await expect(
        handlers.get('providers.update')!(
          { id: created.id, params: {}, credentials: { apiKey: 'sk-new' } },
          {}
        )
      ).rejects.toThrow('macOS Keychain is locked or unavailable');

      // Record unchanged: authType stays 'none', no providers.changed emitted.
      const after = repo.getProvider(created.id);
      expect(after?.authType).toBe('none');
      expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });
  });

  describe('providers.delete', () => {
    it('disables a built-in provider instead of deleting the row', async () => {
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
      const after = repo.getProvider(created.id);
      expect(after).not.toBeNull();
      expect(after?.isEnabled).toBe(false);
    });

    it('throws when provider not found', async () => {
      const handlers = setup();
      await expect(handlers.get('providers.delete')!({ id: 'missing' }, {})).rejects.toThrow(
        'not found'
      );
    });

    it('blocks delete when removeCredentials throws KeychainUnavailableError for built_in', async () => {
      // Keychain-only persistence: if the keychain is locked, do not delete the
      // provider config while a stale credential may remain in Keychain.
      const created = repo.createProvider({
        providerId: 'my-provider',
        displayName: 'My Provider',
        kind: 'built_in',
        authType: 'api_key',
      });
      creds.removeCredentials = mock(async () => {
        throw new KeychainUnavailableError('The user name or passphrase is not correct');
      });
      const handlers = setup();

      await expect(handlers.get('providers.delete')!({ id: created.id }, {})).rejects.toThrow(
        'security unlock-keychain'
      );

      expect(repo.getProvider(created.id)).not.toBeNull();
      expect(creds.removeCredentials).toHaveBeenCalledWith('my-provider');
      expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });

    it('allows custom_endpoint delete even when keychain is locked', async () => {
      // Custom endpoints store auth inline in config JSON, not the credential
      // store. A locked keychain must not block removing the endpoint row.
      const created = repo.createProvider({
        providerId: 'my-endpoint',
        displayName: 'My Endpoint',
        kind: 'custom_endpoint',
        authType: 'api_key',
      });
      creds.removeCredentials = mock(async () => {
        throw new KeychainUnavailableError('keychain locked');
      });
      const handlers = setup();

      const result = (await handlers.get('providers.delete')!({ id: created.id }, {})) as {
        success: boolean;
      };

      expect(result.success).toBe(true);
      expect(repo.getProvider(created.id)).toBeNull();
      expect(creds.removeCredentials).not.toHaveBeenCalled();
      expect(eventBus.publishAsync).toHaveBeenCalledWith('providers.changed', {
        sessionId: 'global',
      });
    });

    it('rethrows non-keychain errors from removeCredentials', async () => {
      const created = repo.createProvider({
        providerId: 'my-provider',
        displayName: 'My Provider',
        kind: 'built_in',
        authType: 'api_key',
      });
      creds.removeCredentials = mock(async () => {
        throw new Error('database is locked');
      });
      const handlers = setup();

      await expect(handlers.get('providers.delete')!({ id: created.id }, {})).rejects.toThrow(
        'database is locked'
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

  describe('providers.healthCheck', () => {
    it('returns healthy results for available providers', async () => {
      repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      repo.createProvider({
        providerId: 'openrouter',
        displayName: 'OpenRouter',
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
      const result = (await handlers.get('providers.healthCheck')!({}, {})) as {
        results: Array<{ providerId: string; healthy: boolean; error?: string }>;
      };

      expect(result.results.length).toBe(2);
      const anthropic = result.results.find((r) => r.providerId === 'anthropic');
      const openrouter = result.results.find((r) => r.providerId === 'openrouter');
      expect(anthropic?.healthy).toBe(true);
      expect(openrouter?.healthy).toBe(false);
      expect(openrouter?.error).toBe('Not registered');
    });

    it('returns unhealthy when provider is not available', async () => {
      repo.createProvider({
        providerId: 'unavailable',
        displayName: 'Unavailable',
        kind: 'built_in',
        authType: 'api_key',
      });
      const registry = getProviderRegistry();
      registry.register({
        id: 'unavailable',
        displayName: 'Unavailable',
        capabilities: {
          streaming: true,
          extendedThinking: false,
          thinkingModes: 'off',
          maxContextWindow: 1000,
          functionCalling: false,
          vision: false,
        },
        isAvailable: () => false,
        getModels: async () => [],
        ownsModel: () => true,
        getModelForTier: () => 'default',
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
      } as Provider);

      const handlers = setup();
      const result = (await handlers.get('providers.healthCheck')!({}, {})) as {
        results: Array<{ providerId: string; healthy: boolean; error?: string }>;
      };

      expect(result.results[0].healthy).toBe(false);
      expect(result.results[0].error).toBe('Not available');
    });

    it('returns unhealthy when getModels throws', async () => {
      repo.createProvider({
        providerId: 'broken',
        displayName: 'Broken',
        kind: 'built_in',
        authType: 'api_key',
      });
      const registry = getProviderRegistry();
      registry.register({
        id: 'broken',
        displayName: 'Broken',
        capabilities: {
          streaming: true,
          extendedThinking: false,
          thinkingModes: 'off',
          maxContextWindow: 1000,
          functionCalling: false,
          vision: false,
        },
        isAvailable: () => true,
        getModels: async () => {
          throw new Error('model fetch failed');
        },
        ownsModel: () => true,
        getModelForTier: () => 'default',
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
      } as Provider);

      const handlers = setup();
      const result = (await handlers.get('providers.healthCheck')!({}, {})) as {
        results: Array<{ providerId: string; healthy: boolean; error?: string }>;
      };

      expect(result.results[0].healthy).toBe(false);
      expect(result.results[0].error).toBe('model fetch failed');
    });
  });
});

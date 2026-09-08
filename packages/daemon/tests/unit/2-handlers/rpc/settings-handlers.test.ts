import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub, type GlobalSettings, DEFAULT_GLOBAL_SETTINGS } from '@hyperneo/shared';
import {
  applyProviderModelAllowlistsToEnv,
  registerSettingsHandlers,
} from '../../../../src/lib/rpc-handlers/settings-handlers';
import type { SettingsManager } from '../../../../src/lib/settings-manager';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';
import type { Database } from '../../../../src/storage/database';
import type {
  InternalEventBus,
  DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus';
import type { ProviderCredentialManager } from '../../../../src/lib/credentials/provider-credential-manager';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): {
  hub: MessageHub;
  handlers: Map<string, RequestHandler>;
} {
  const handlers = new Map<string, RequestHandler>();

  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    onEvent: mock(() => () => {}),
    request: mock(async () => {}),
    event: mock(() => {}),
    joinChannel: mock(async () => {}),
    leaveChannel: mock(async () => {}),
    isConnected: mock(() => true),
    getState: mock(() => 'connected' as const),
    onConnection: mock(() => () => {}),
    onMessage: mock(() => () => {}),
    cleanup: mock(() => {}),
    registerTransport: mock(() => () => {}),
    registerRouter: mock(() => {}),
    getRouter: mock(() => null),
    getPendingCallCount: mock(() => 0),
  } as unknown as MessageHub;

  return { hub, handlers };
}

function createMockDaemonHub(): {
  daemonHub: DaemonHub;
  emitMock: ReturnType<typeof mock>;
} {
  const emitMock = mock(async () => {});
  const daemonHub = {
    emit: emitMock,
    on: mock(() => () => {}),
    off: mock(() => {}),
    once: mock(async () => {}),
  } as unknown as DaemonHub;

  return { daemonHub, emitMock };
}

function createMockInternalEventBus(): {
  bus: InternalEventBus<DaemonInternalEventMap>;
  publishAsyncMock: ReturnType<typeof mock>;
} {
  const publishAsyncMock = mock(() => {});
  const bus = {
    publishAsync: publishAsyncMock,
    publish: mock(async () => ({ delivered: 0, failures: [] })),
    subscribe: mock(() => () => {}),
    getHandlerCount: mock(() => 0),
    getHandlerCountForNamespace: mock(() => 0),
    clear: mock(() => {}),
    off: mock(() => {}),
  } as unknown as InternalEventBus<DaemonInternalEventMap>;

  return { bus, publishAsyncMock };
}

const defaultGlobalSettings: GlobalSettings = {
  ...DEFAULT_GLOBAL_SETTINGS,
  showArchived: false,
  model: 'claude-sonnet-4-20250514',
};

function createMockSettingsManager(): {
  settingsManager: SettingsManager;
  mocks: {
    getGlobalSettings: ReturnType<typeof mock>;
    updateGlobalSettings: ReturnType<typeof mock>;
    saveGlobalSettings: ReturnType<typeof mock>;
  };
} {
  const mocks = {
    getGlobalSettings: mock(() => defaultGlobalSettings),
    updateGlobalSettings: mock((updates: Partial<GlobalSettings>) => ({
      ...defaultGlobalSettings,
      ...updates,
    })),
    saveGlobalSettings: mock(() => {}),
  };

  return {
    settingsManager: {
      ...mocks,
    } as unknown as SettingsManager,
    mocks,
  };
}

function createMockDatabase(): {
  db: Database;
  mocks: {
    getSession: ReturnType<typeof mock>;
    getDatabase: ReturnType<typeof mock>;
  };
} {
  const stmt = {
    get: mock(() => ({ totalCost: 0, totalTokens: 0, totalMessages: 0, sessionCount: 0 })),
    all: mock(() => []),
  };
  const mocks = {
    getSession: mock(() => ({
      id: 'session-123',
      workspacePath: '/workspace/test',
    })),
    getDatabase: mock(() => ({
      prepare: mock(() => stmt),
    })),
  };

  return {
    db: {
      getSession: mocks.getSession,
      getDatabase: mocks.getDatabase,
      workspaceHistory: {
        list: mock(() => []),
      },
      appMcpServers: {
        listImported: mock(() => []),
      },
    } as unknown as Database,
    mocks,
  };
}

function createMockCredentialManager(): {
  manager: ProviderCredentialManager;
  storeApiKey: ReturnType<typeof mock>;
  removeCredentials: ReturnType<typeof mock>;
  getCredentials: ReturnType<typeof mock>;
} {
  const storeApiKey = mock(async () => {});
  const removeCredentials = mock(async () => {});
  const getCredentials = mock(async () => null);
  return {
    manager: {
      storeApiKey,
      removeCredentials,
      getCredentials,
    } as unknown as ProviderCredentialManager,
    storeApiKey,
    removeCredentials,
    getCredentials,
  };
}

describe('Settings RPC Handlers', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let internalEventBusData: ReturnType<typeof createMockInternalEventBus>;
  let settingsManagerData: ReturnType<typeof createMockSettingsManager>;
  let dbData: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    messageHubData = createMockMessageHub();
    internalEventBusData = createMockInternalEventBus();
    settingsManagerData = createMockSettingsManager();
    dbData = createMockDatabase();

    registerSettingsHandlers(
      messageHubData.hub,
      settingsManagerData.settingsManager,
      internalEventBusData.bus,
      dbData.db
    );
  });

  afterEach(() => {
    delete process.env.HYPERNEO_PROVIDER_MODEL_ALLOWLISTS;
    mock.restore();
  });

  describe('provider model allowlist sync', () => {
    it('hydrates provider allowlists into env for startup model initialization', () => {
      applyProviderModelAllowlistsToEnv({
        openrouter: ['xai/grok-4.3', ' deepseek/deepseek-v4-pro '],
        anthropic: ['claude-sonnet-4.6'],
      });

      expect(process.env.HYPERNEO_PROVIDER_MODEL_ALLOWLISTS).toBe(
        'openrouter:xai/grok-4.3\nopenrouter:deepseek/deepseek-v4-pro\nanthropic:claude-sonnet-4.6'
      );
    });

    it('clears provider allowlist env when no persisted allowlists exist', () => {
      process.env.HYPERNEO_PROVIDER_MODEL_ALLOWLISTS = 'openrouter:xai/grok-4.3';

      applyProviderModelAllowlistsToEnv(undefined);

      expect(process.env.HYPERNEO_PROVIDER_MODEL_ALLOWLISTS).toBeUndefined();
    });

    it('advances the removed provider revision when its allowlist key is dropped', async () => {
      const { syncProviderModelAllowlists } = await import(
        '../../../../src/lib/rpc-handlers/settings-handlers'
      );
      const { getProviderCatalogEpoch } = await import('../../../../src/lib/model-service');
      process.env.HYPERNEO_PROVIDER_MODEL_ALLOWLISTS = 'openrouter:xai/grok-4.3';
      const before = getProviderCatalogEpoch('openrouter');

      await syncProviderModelAllowlists({});

      expect(process.env.HYPERNEO_PROVIDER_MODEL_ALLOWLISTS).toBeUndefined();
      expect(getProviderCatalogEpoch('openrouter')).toBeGreaterThan(before);
    });
  });

  describe('settings.global.update', () => {
    it('updates global settings partially', async () => {
      const handler = messageHubData.handlers.get('settings.global.update');
      expect(handler).toBeDefined();

      const result = (await handler!({ updates: { model: 'claude-opus' } }, {})) as {
        success: boolean;
        settings: GlobalSettings;
      };

      expect(result.success).toBe(true);
      expect(result.settings.model).toBe('claude-opus');
    });

    it('publishes settings.updated event through internalEventBus', async () => {
      const handler = messageHubData.handlers.get('settings.global.update');
      expect(handler).toBeDefined();

      await handler!({ updates: { model: 'claude-opus' } }, {});

      expect(internalEventBusData.publishAsyncMock).toHaveBeenCalledWith(
        'settings.updated',
        expect.objectContaining({
          namespaceId: 'global',
        })
      );
    });

    it('publishes settings.updated through internalEventBus when showArchived changes', async () => {
      const handler = messageHubData.handlers.get('settings.global.update');
      expect(handler).toBeDefined();

      await handler!({ updates: { showArchived: true } }, {});

      expect(internalEventBusData.publishAsyncMock).toHaveBeenCalledWith(
        'settings.updated',
        expect.objectContaining({
          namespaceId: 'global',
        })
      );
    });

    it('handles multiple updates', async () => {
      const handler = messageHubData.handlers.get('settings.global.update');
      expect(handler).toBeDefined();

      const result = (await handler!(
        { updates: { model: 'claude-opus', showArchived: true } },
        {}
      )) as { success: boolean; settings: GlobalSettings };

      expect(result.success).toBe(true);
      expect(result.settings.model).toBe('claude-opus');
      expect(result.settings.showArchived).toBe(true);
    });

    it('stores voice apiKey in credentials and returns only hasApiKey', async () => {
      const credentialManager = createMockCredentialManager();
      const hubData = createMockMessageHub();
      registerSettingsHandlers(
        hubData.hub,
        settingsManagerData.settingsManager,
        internalEventBusData.bus,
        dbData.db,
        credentialManager.manager
      );
      const handler = hubData.handlers.get('settings.global.update');

      const result = (await handler!(
        {
          updates: {
            voice: {
              enabled: true,
              endpoint: 'https://api.openai.com/v1/audio/transcriptions',
              model: 'whisper-1',
              apiKey: 'sk-test',
            },
          },
        },
        {}
      )) as { settings: GlobalSettings };

      expect(credentialManager.storeApiKey).toHaveBeenCalledWith('voice-transcription', 'sk-test');
      expect(result.settings.voice?.apiKey).toBeUndefined();
      expect(result.settings.voice?.hasApiKey).toBe(true);
      expect(result.settings.voice?.apiKeyEndpoint).toBe(
        'https://api.openai.com/v1/audio/transcriptions'
      );
    });

    it('removes stored voice credentials when hasApiKey is cleared', async () => {
      const credentialManager = createMockCredentialManager();
      settingsManagerData.mocks.getGlobalSettings.mockReturnValue({
        ...defaultGlobalSettings,
        voice: {
          enabled: true,
          endpoint: 'http://ai0:9002/v1/audio/transcriptions',
          model: 'qwen3-asr',
          hasApiKey: true,
        },
      });
      const hubData = createMockMessageHub();
      registerSettingsHandlers(
        hubData.hub,
        settingsManagerData.settingsManager,
        internalEventBusData.bus,
        dbData.db,
        credentialManager.manager
      );
      const handler = hubData.handlers.get('settings.global.update');

      await handler!(
        {
          updates: {
            voice: {
              enabled: true,
              endpoint: 'http://ai0:9002/v1/audio/transcriptions',
              model: 'qwen3-asr',
              hasApiKey: false,
            },
          },
        },
        {}
      );

      expect(credentialManager.removeCredentials).toHaveBeenCalledWith('voice-transcription');
    });

    it('rejects an API key before an endpoint is configured', async () => {
      const credentialManager = createMockCredentialManager();
      const hubData = createMockMessageHub();
      registerSettingsHandlers(
        hubData.hub,
        settingsManagerData.settingsManager,
        internalEventBusData.bus,
        dbData.db,
        credentialManager.manager
      );
      const handler = hubData.handlers.get('settings.global.update');

      await expect(
        handler!(
          {
            updates: {
              voice: {
                enabled: true,
                endpoint: '',
                model: 'whisper-1',
                apiKey: 'sk-test',
              },
            },
          },
          {}
        )
      ).rejects.toThrow('Configure the voice transcription endpoint before saving an API key');
      expect(credentialManager.storeApiKey).not.toHaveBeenCalled();
    });

    it('does not store the credential when the settings write fails', async () => {
      const credentialManager = createMockCredentialManager();
      const hubData = createMockMessageHub();
      registerSettingsHandlers(
        hubData.hub,
        settingsManagerData.settingsManager,
        internalEventBusData.bus,
        dbData.db,
        credentialManager.manager
      );
      const handler = hubData.handlers.get('settings.global.update');
      settingsManagerData.mocks.updateGlobalSettings.mockImplementationOnce(() => {
        throw new Error('database is locked');
      });

      await expect(
        handler!(
          {
            updates: {
              voice: {
                enabled: true,
                endpoint: 'https://api.openai.com/v1/audio/transcriptions',
                model: 'whisper-1',
                apiKey: 'sk-test',
              },
            },
          },
          {}
        )
      ).rejects.toThrow('database is locked');
      expect(credentialManager.storeApiKey).not.toHaveBeenCalled();
    });

    it('ignores a client-forged apiKeyEndpoint scope', async () => {
      const credentialManager = createMockCredentialManager();
      const trustedScope = 'https://api.openai.com/v1/audio/transcriptions';
      settingsManagerData.mocks.getGlobalSettings.mockReturnValue({
        ...defaultGlobalSettings,
        voice: {
          enabled: true,
          endpoint: trustedScope,
          model: 'whisper-1',
          hasApiKey: true,
          apiKeyEndpoint: trustedScope,
        },
      });
      const hubData = createMockMessageHub();
      registerSettingsHandlers(
        hubData.hub,
        settingsManagerData.settingsManager,
        internalEventBusData.bus,
        dbData.db,
        credentialManager.manager
      );
      const handler = hubData.handlers.get('settings.global.update');

      const result = (await handler!(
        {
          updates: {
            voice: {
              enabled: true,
              endpoint: 'https://attacker.example.com/v1/audio/transcriptions',
              model: 'whisper-1',
              hasApiKey: true,
              apiKeyEndpoint: 'https://attacker.example.com/v1/audio/transcriptions',
            },
          },
        },
        {}
      )) as { settings: GlobalSettings };

      expect(result.settings.voice?.apiKeyEndpoint).toBe(trustedScope);
      expect(result.settings.voice?.hasApiKey).toBe(true);
      expect(credentialManager.storeApiKey).not.toHaveBeenCalled();
    });

    it('restores the prior credential when a new key write partially fails', async () => {
      const credentialManager = createMockCredentialManager();
      credentialManager.getCredentials.mockImplementation(async () => ({
        type: 'api_key' as const,
        apiKey: 'old-key',
      }));
      credentialManager.storeApiKey.mockImplementation(async (_id: string, key: string) => {
        if (key === 'new-key') throw new Error('partial write');
      });
      const hubData = createMockMessageHub();
      registerSettingsHandlers(
        hubData.hub,
        settingsManagerData.settingsManager,
        internalEventBusData.bus,
        dbData.db,
        credentialManager.manager
      );
      const handler = hubData.handlers.get('settings.global.update');

      await expect(
        handler!(
          {
            updates: {
              voice: {
                enabled: true,
                endpoint: 'https://api.openai.com/v1/audio/transcriptions',
                model: 'whisper-1',
                apiKey: 'new-key',
              },
            },
          },
          {}
        )
      ).rejects.toThrow('partial write');

      const calls = credentialManager.storeApiKey.mock.calls as Array<[string, string]>;
      expect(calls.map((c) => c[1])).toEqual(['new-key', 'old-key']);
    });

    it('aborts the mutation when the prior-credential read fails', async () => {
      const credentialManager = createMockCredentialManager();
      credentialManager.getCredentials.mockImplementation(async () => {
        throw new Error('keychain read failed');
      });
      const hubData = createMockMessageHub();
      registerSettingsHandlers(
        hubData.hub,
        settingsManagerData.settingsManager,
        internalEventBusData.bus,
        dbData.db,
        credentialManager.manager
      );
      const handler = hubData.handlers.get('settings.global.update');

      await expect(
        handler!(
          {
            updates: {
              voice: {
                enabled: true,
                endpoint: 'https://api.openai.com/v1/audio/transcriptions',
                model: 'whisper-1',
                apiKey: 'new-key',
              },
            },
          },
          {}
        )
      ).rejects.toThrow('keychain read failed');

      expect(settingsManagerData.mocks.updateGlobalSettings).not.toHaveBeenCalled();
      expect(credentialManager.storeApiKey).not.toHaveBeenCalled();
    });

    it('rolls back the settings write when the credential store fails', async () => {
      const credentialManager = createMockCredentialManager();
      credentialManager.storeApiKey.mockImplementationOnce(async () => {
        throw new Error('credential store unavailable');
      });
      const hubData = createMockMessageHub();
      registerSettingsHandlers(
        hubData.hub,
        settingsManagerData.settingsManager,
        internalEventBusData.bus,
        dbData.db,
        credentialManager.manager
      );
      const handler = hubData.handlers.get('settings.global.update');

      await expect(
        handler!(
          {
            updates: {
              voice: {
                enabled: true,
                endpoint: 'https://api.openai.com/v1/audio/transcriptions',
                model: 'whisper-1',
                apiKey: 'sk-test',
              },
            },
          },
          {}
        )
      ).rejects.toThrow('credential store unavailable');

      expect(settingsManagerData.mocks.saveGlobalSettings).toHaveBeenCalledTimes(1);
      const rollbackCall = settingsManagerData.mocks.saveGlobalSettings.mock.calls[0][0];
      expect(rollbackCall.voice?.apiKeyEndpoint).toBeUndefined();
    });
  });

  describe('handler registration', () => {
    it('registers settings.global.update handler', () => {
      expect(messageHubData.handlers.has('settings.global.update')).toBe(true);
    });

    it('does NOT register removed legacy MCP handlers', () => {
      expect(messageHubData.handlers.has('settings.mcp.toggle')).toBe(false);
      expect(messageHubData.handlers.has('settings.mcp.setDisabled')).toBe(false);
      expect(messageHubData.handlers.has('settings.mcp.getDisabled')).toBe(false);
      expect(messageHubData.handlers.has('settings.mcp.updateServerSettings')).toBe(false);
    });

    it('does NOT register removed dead settings handlers', () => {
      expect(messageHubData.handlers.has('settings.global.get')).toBe(false);
      expect(messageHubData.handlers.has('settings.global.save')).toBe(false);
      expect(messageHubData.handlers.has('settings.fileOnly.read')).toBe(false);
      expect(messageHubData.handlers.has('settings.mcp.listFromSources')).toBe(false);
      expect(messageHubData.handlers.has('settings.mcp.refreshImports')).toBe(false);
      expect(messageHubData.handlers.has('settings.session.get')).toBe(false);
      expect(messageHubData.handlers.has('settings.session.update')).toBe(false);
    });
  });
});

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import {
  MessageHub,
  type GlobalSettings,
  type SessionSettings,
  DEFAULT_GLOBAL_SETTINGS,
} from '@hyperneo/shared';
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
    readFileOnlySettings: ReturnType<typeof mock>;
    listMcpServersFromSources: ReturnType<typeof mock>;
  };
} {
  const mocks = {
    getGlobalSettings: mock(() => defaultGlobalSettings),
    updateGlobalSettings: mock((updates: Partial<GlobalSettings>) => ({
      ...defaultGlobalSettings,
      ...updates,
    })),
    saveGlobalSettings: mock(() => {}),
    readFileOnlySettings: mock(() => ({ someSetting: 'value' })),
    listMcpServersFromSources: mock(() => [
      { name: 'server-1', command: 'npx', args: ['-y', 'mcp-server-1'] },
      { name: 'server-2', command: 'npx', args: ['-y', 'mcp-server-2'] },
    ]),
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

function createMockMcpImportService(): {
  service: import('../../../../src/lib/mcp').McpImportService;
  refreshAllMock: ReturnType<typeof mock>;
} {
  const refreshAllMock = mock(() => ({ results: [], orphanPruned: 0 }));
  const service = {
    refreshAll: refreshAllMock,
  } as unknown as import('../../../../src/lib/mcp').McpImportService;

  return { service, refreshAllMock };
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
  let mcpImportServiceData: ReturnType<typeof createMockMcpImportService>;

  beforeEach(() => {
    messageHubData = createMockMessageHub();
    internalEventBusData = createMockInternalEventBus();
    settingsManagerData = createMockSettingsManager();
    dbData = createMockDatabase();
    mcpImportServiceData = createMockMcpImportService();

    registerSettingsHandlers(
      messageHubData.hub,
      settingsManagerData.settingsManager,
      internalEventBusData.bus,
      dbData.db,
      mcpImportServiceData.service
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
  });

  describe('settings.global.get', () => {
    it('returns global settings', async () => {
      const handler = messageHubData.handlers.get('settings.global.get');
      expect(handler).toBeDefined();

      const result = (await handler!({}, {})) as GlobalSettings;

      expect(result).toBeDefined();
      expect(result.showArchived).toBe(false);
    });

    it('calls getGlobalSettings on settings manager', async () => {
      const handler = messageHubData.handlers.get('settings.global.get');
      expect(handler).toBeDefined();

      await handler!({}, {});

      expect(settingsManagerData.mocks.getGlobalSettings).toHaveBeenCalled();
    });

    it('strips voice apiKey and exposes hasApiKey', async () => {
      settingsManagerData.mocks.getGlobalSettings.mockReturnValue({
        ...defaultGlobalSettings,
        voice: {
          enabled: true,
          endpoint: 'https://api.openai.com/v1/audio/transcriptions',
          model: 'whisper-1',
          apiKey: 'sk-test',
        },
      });
      const handler = messageHubData.handlers.get('settings.global.get');

      const result = (await handler!({}, {})) as GlobalSettings;

      expect(result.voice?.apiKey).toBeUndefined();
      expect(result.voice?.hasApiKey).toBe(true);
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
        mcpImportServiceData.service,
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
        mcpImportServiceData.service,
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
        mcpImportServiceData.service,
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
        mcpImportServiceData.service,
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
        mcpImportServiceData.service,
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
        mcpImportServiceData.service,
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
        mcpImportServiceData.service,
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
        mcpImportServiceData.service,
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

  describe('settings.global.save', () => {
    it('saves global settings', async () => {
      const handler = messageHubData.handlers.get('settings.global.save');
      expect(handler).toBeDefined();

      const newSettings: GlobalSettings = {
        ...defaultGlobalSettings,
        showArchived: true,
        model: 'claude-opus',
      };

      const result = (await handler!({ settings: newSettings }, {})) as { success: boolean };

      expect(result.success).toBe(true);
      expect(settingsManagerData.mocks.saveGlobalSettings).toHaveBeenCalledWith(newSettings);
    });

    it('preserves the voice block when a full save omits it', async () => {
      const priorVoice = {
        enabled: true,
        endpoint: 'https://asr.example.com/v1/audio/transcriptions',
        model: 'whisper-1',
      };
      settingsManagerData.mocks.getGlobalSettings.mockReturnValue({
        ...defaultGlobalSettings,
        voice: priorVoice,
      });
      const handler = messageHubData.handlers.get('settings.global.save');
      const { voice: _omitVoice, ...withoutVoice } = defaultGlobalSettings;
      const payload = { ...withoutVoice, model: 'claude-opus' };

      await handler!({ settings: payload as GlobalSettings }, {});

      const saved = settingsManagerData.mocks.saveGlobalSettings.mock.calls[0][0] as GlobalSettings;
      expect(saved.voice).toEqual(priorVoice);
    });

    it('publishes settings.updated event through internalEventBus', async () => {
      const handler = messageHubData.handlers.get('settings.global.save');
      expect(handler).toBeDefined();

      await handler!({ settings: defaultGlobalSettings }, {});

      expect(internalEventBusData.publishAsyncMock).toHaveBeenCalledWith(
        'settings.updated',
        expect.objectContaining({
          namespaceId: 'global',
        })
      );
    });
  });

  describe('settings.fileOnly.read', () => {
    it('returns file-only settings', async () => {
      const handler = messageHubData.handlers.get('settings.fileOnly.read');
      expect(handler).toBeDefined();

      const result = await handler!({}, {});

      expect(result).toBeDefined();
      expect(settingsManagerData.mocks.readFileOnlySettings).toHaveBeenCalled();
    });
  });

  describe('settings.mcp.listFromSources', () => {
    it('returns MCP servers from global sources when no sessionId', async () => {
      const handler = messageHubData.handlers.get('settings.mcp.listFromSources');
      expect(handler).toBeDefined();

      const result = (await handler!({}, {})) as {
        servers: Array<{ name: string }>;
      };

      expect(result.servers).toBeDefined();
      expect(result.servers).toHaveLength(2);
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('settings.mcp.listFromSources');
      expect(handler).toBeDefined();

      dbData.mocks.getSession.mockReturnValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
        'Session not found: non-existent'
      );
    });

    it('accepts sessionId parameter', async () => {
      const handler = messageHubData.handlers.get('settings.mcp.listFromSources');
      expect(handler).toBeDefined();

      expect(typeof handler).toBe('function');
    });
  });

  describe('settings.mcp.refreshImports', () => {
    it('returns empty results when mcpImportService is undefined', async () => {
      registerSettingsHandlers(
        messageHubData.hub,
        settingsManagerData.settingsManager,
        internalEventBusData.bus,
        dbData.db
      );

      const handler = messageHubData.handlers.get('settings.mcp.refreshImports');
      expect(handler).toBeDefined();

      const result = (await handler!({}, {})) as { results: unknown[] };

      expect(result.results).toEqual([]);
    });

    it('calls refreshAll and publishes settings.updated through internalEventBus', async () => {
      const handler = messageHubData.handlers.get('settings.mcp.refreshImports');
      expect(handler).toBeDefined();

      const result = (await handler!({}, {})) as { results: unknown[] };

      expect(mcpImportServiceData.refreshAllMock).toHaveBeenCalled();
      expect(internalEventBusData.publishAsyncMock).toHaveBeenCalledWith(
        'settings.updated',
        expect.objectContaining({
          namespaceId: 'global',
        })
      );
      expect(result.results).toEqual([]);
    });
  });

  describe('settings.session.get', () => {
    it('returns session settings', async () => {
      const handler = messageHubData.handlers.get('settings.session.get');
      expect(handler).toBeDefined();

      const result = (await handler!({ sessionId: 'session-123' }, {})) as {
        sessionId: string;
        settings: SessionSettings;
      };

      expect(result.sessionId).toBe('session-123');
      expect(result.settings).toBeDefined();
    });
  });

  describe('settings.session.update', () => {
    it('updates session settings', async () => {
      const handler = messageHubData.handlers.get('settings.session.update');
      expect(handler).toBeDefined();

      const result = (await handler!(
        { sessionId: 'session-123', updates: { someSetting: 'value' } },
        {}
      )) as { success: boolean; sessionId: string };

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe('session-123');
    });
  });

  describe('handler registration', () => {
    it('registers settings.global.get handler', () => {
      expect(messageHubData.handlers.has('settings.global.get')).toBe(true);
    });

    it('registers settings.global.update handler', () => {
      expect(messageHubData.handlers.has('settings.global.update')).toBe(true);
    });

    it('registers settings.global.save handler', () => {
      expect(messageHubData.handlers.has('settings.global.save')).toBe(true);
    });

    it('registers settings.fileOnly.read handler', () => {
      expect(messageHubData.handlers.has('settings.fileOnly.read')).toBe(true);
    });

    it('registers settings.mcp.listFromSources handler', () => {
      expect(messageHubData.handlers.has('settings.mcp.listFromSources')).toBe(true);
    });

    it('registers settings.session.get handler', () => {
      expect(messageHubData.handlers.has('settings.session.get')).toBe(true);
    });

    it('registers settings.session.update handler', () => {
      expect(messageHubData.handlers.has('settings.session.update')).toBe(true);
    });

    it('does NOT register removed legacy MCP handlers', () => {
      expect(messageHubData.handlers.has('settings.mcp.toggle')).toBe(false);
      expect(messageHubData.handlers.has('settings.mcp.setDisabled')).toBe(false);
      expect(messageHubData.handlers.has('settings.mcp.getDisabled')).toBe(false);
      expect(messageHubData.handlers.has('settings.mcp.updateServerSettings')).toBe(false);
    });
  });
});

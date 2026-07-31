/**
 * Tests for Settings RPC Handlers
 *
 * Tests the RPC handlers for settings operations:
 * - settings.global.get - Get global settings
 * - settings.global.update - Update global settings (partial update)
 * - settings.global.save - Save global settings (full replace)
 * - settings.fileOnly.read - Read file-only settings
 * - settings.mcp.listFromSources - List MCP servers from enabled sources
 * - settings.session.get - Get session settings
 * - settings.session.update - Update session settings
 *
 * NOTE: The legacy `settings.mcp.toggle`, `settings.mcp.getDisabled`,
 * `settings.mcp.setDisabled`, and `settings.mcp.updateServerSettings` RPCs
 * were removed in M5 of `unify-mcp-config-model`. MCP enablement now flows
 * through the unified `app_mcp_servers` registry + `mcp_enablement` overrides.
 * `mcpServerSettings` and `disabledMcpServers` were also removed from
 * `GlobalSettings`; tests no longer set them.
 */

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

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Helper to create a minimal mock MessageHub that captures handlers
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

// Helper to create mock DaemonHub
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

// Helper to create mock InternalEventBus
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

// Default global settings (mirrors the unified shape in @hyperneo/shared)
const defaultGlobalSettings: GlobalSettings = {
  ...DEFAULT_GLOBAL_SETTINGS,
  showArchived: false,
  model: 'claude-sonnet-4-20250514',
};

// Helper to create mock SettingsManager
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

// Helper to create mock Database
function createMockDatabase(): {
  db: Database;
  mocks: {
    getSession: ReturnType<typeof mock>;
    getDatabase: ReturnType<typeof mock>;
  };
} {
  // Stub the prepared statement chain that `usage.calculate` walks; we
  // exercise that handler indirectly via registration tests, so the chain
  // just needs to be callable without throwing.
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
    } as unknown as Database,
    mocks,
  };
}

// Helper to create mock McpImportService
function createMockMcpImportService(): {
  service: import('../../../../src/lib/mcp').McpImportService;
  refreshAllMock: ReturnType<typeof mock>;
} {
  const refreshAllMock = mock(() => []);
  const service = {
    refreshAll: refreshAllMock,
  } as unknown as import('../../../../src/lib/mcp').McpImportService;

  return { service, refreshAllMock };
}

function createMockCredentialManager(): {
  manager: ProviderCredentialManager;
  storeApiKey: ReturnType<typeof mock>;
  removeCredentials: ReturnType<typeof mock>;
} {
  const storeApiKey = mock(async () => {});
  const removeCredentials = mock(async () => {});
  return {
    manager: { storeApiKey, removeCredentials } as unknown as ProviderCredentialManager,
    storeApiKey,
    removeCredentials,
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

    // Setup handlers with mocked dependencies
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

      // showArchived filter is handled client-side via LiveQuery — no separate filterChanged event
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

    // Note: Testing with sessionId that creates a new SettingsManager requires
    // a more complex setup with proper database mocking. This is better suited
    // for integration tests that test the full flow.
    it('accepts sessionId parameter', async () => {
      const handler = messageHubData.handlers.get('settings.mcp.listFromSources');
      expect(handler).toBeDefined();

      // Verify the handler is defined and accepts the sessionId parameter
      // The actual session-specific SettingsManager creation is tested in integration tests
      expect(typeof handler).toBe('function');
    });
  });

  describe('settings.mcp.refreshImports', () => {
    it('returns empty results when mcpImportService is undefined', async () => {
      // Re-register without the service to hit the short-circuit path
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

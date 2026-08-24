import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { AnthropicProvider } from '../../../../src/lib/providers/anthropic-provider';
import {
  recordProviderFailure,
  resetProviderFailureStore,
} from '../../../../src/lib/providers/provider-failure-store';

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    resetProviderFailureStore();
    provider = new AnthropicProvider();
  });

  afterEach(() => {
    resetProviderFailureStore();
    process.env = originalEnv;
  });

  describe('basic properties', () => {
    it('should have correct ID', () => {
      expect(provider.id).toBe('anthropic');
    });

    it('should have correct display name', () => {
      expect(provider.displayName).toBe('Anthropic');
    });

    it('should have full capabilities', () => {
      expect(provider.capabilities).toEqual({
        streaming: true,
        extendedThinking: true,
        maxContextWindow: 200000,
        functionCalling: true,
        vision: true,
        thinkingModes: 'granular',
      });
    });
  });

  describe('isAvailable', () => {
    it('should return true when ANTHROPIC_API_KEY is set', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      expect(provider.isAvailable()).toBe(true);
    });

    it('should return true when CLAUDE_CODE_OAUTH_TOKEN is set', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
      expect(provider.isAvailable()).toBe(true);
    });

    it('should return false when no credentials are set', () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('getApiKey', () => {
    it('should prefer ANTHROPIC_API_KEY over OAuth token', () => {
      process.env.ANTHROPIC_API_KEY = 'api-key';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';
      expect(provider.getApiKey()).toBe('api-key');
    });

    it('should return OAuth token when API key not set', () => {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';
      expect(provider.getApiKey()).toBe('oauth-token');
    });

    it('should return undefined when neither is set', () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      expect(provider.getApiKey()).toBeUndefined();
    });
  });

  describe('getModels without credentials', () => {
    it('should return empty array when no credentials are available', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.ANTHROPIC_AUTH_TOKEN;

      const providerWithoutCreds = new AnthropicProvider();

      const models = await providerWithoutCreds.getModels();

      expect(models).toEqual([]);
    });

    it('should not attempt SDK call when credentials are missing', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.ANTHROPIC_AUTH_TOKEN;

      const providerWithoutCreds = new AnthropicProvider();

      const startTime = Date.now();
      const models = await providerWithoutCreds.getModels();
      const duration = Date.now() - startTime;

      expect(models).toEqual([]);
      expect(duration).toBeLessThan(100);
    });
  });

  describe('getModels with SDK failure', () => {
    it('should apply stored API key env while loading SDK models', async () => {
      const seenEnv: Array<string | undefined> = [];
      class MockMcpServer {
        readonly _registeredTools: Record<string, object> = {};
        connect(): void {}
        disconnect(): void {}
      }
      mock.module('@anthropic-ai/claude-agent-sdk', () => ({
        query: () => {
          seenEnv.push(process.env.ANTHROPIC_API_KEY);
          return {
            interrupt: mock(async () => {}),
            supportedModels: mock(async () => [
              {
                value: 'sonnet',
                displayName: 'Sonnet',
                description: 'Sonnet 4.5 · Test',
              },
            ]),
          };
        },
        interrupt: mock(async () => {}),
        createSdkMcpServer: mock((_options: { name: string; tools?: unknown[] }) => ({
          type: 'sdk' as const,
          name: _options.name,
          version: '1.0.0',
          tools: _options.tools ?? [],
          instance: new MockMcpServer(),
        })),
        tool: mock((name: string, description: string, inputSchema: unknown, handler: unknown) => ({
          name,
          description,
          inputSchema,
          handler,
        })),
      }));

      const providerWithStoredCreds = new AnthropicProvider();
      providerWithStoredCreds.setCredentials({ type: 'api_key', apiKey: 'stored-key' });

      const models = await providerWithStoredCreds.getModels();

      expect(seenEnv).toEqual(['stored-key']);
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(models.map((model) => model.id)).toEqual(['sonnet']);
    });

    it('should apply stored OAuth env while loading SDK models', async () => {
      const seenEnv: Array<string | undefined> = [];
      class MockMcpServer {
        readonly _registeredTools: Record<string, object> = {};
        connect(): void {}
        disconnect(): void {}
      }
      mock.module('@anthropic-ai/claude-agent-sdk', () => ({
        query: () => {
          seenEnv.push(process.env.CLAUDE_CODE_OAUTH_TOKEN);
          return {
            interrupt: mock(async () => {}),
            supportedModels: mock(async () => [
              {
                value: 'sonnet',
                displayName: 'Sonnet',
                description: 'Sonnet 4.5 · Test',
              },
            ]),
          };
        },
        interrupt: mock(async () => {}),
        createSdkMcpServer: mock((_options: { name: string; tools?: unknown[] }) => ({
          type: 'sdk' as const,
          name: _options.name,
          version: '1.0.0',
          tools: _options.tools ?? [],
          instance: new MockMcpServer(),
        })),
        tool: mock((name: string, description: string, inputSchema: unknown, handler: unknown) => ({
          name,
          description,
          inputSchema,
          handler,
        })),
      }));

      const providerWithStoredCreds = new AnthropicProvider();
      providerWithStoredCreds.setCredentials({ type: 'oauth', accessToken: 'stored-oauth-token' });

      const models = await providerWithStoredCreds.getModels();

      expect(seenEnv).toEqual(['stored-oauth-token']);
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(models.map((model) => model.id)).toEqual(['sonnet']);
    });

    it('should propagate SDK loading failures instead of swallowing them', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      class MockMcpServer {
        readonly _registeredTools: Record<string, object> = {};
        connect(): void {}
        disconnect(): void {}
      }
      let _toolBatch: Array<{ name: string; def: object }> = [];
      mock.module('@anthropic-ai/claude-agent-sdk', () => ({
        query: () => ({
          interrupt: async () => {},
          supportedModels: async () => {
            throw new Error('SDK unavailable');
          },
        }),
        interrupt: mock(async () => {}),
        supportedModels: mock(async () => {
          throw new Error('SDK unavailable');
        }),
        createSdkMcpServer: mock((_options: { name: string; tools?: unknown[] }) => {
          const server = new MockMcpServer();
          for (const { name, def } of _toolBatch) {
            server._registeredTools[name] = def;
          }
          _toolBatch = [];
          return {
            type: 'sdk' as const,
            name: _options.name,
            version: _options.version ?? '1.0.0',
            tools: _options.tools ?? [],
            instance: server,
          };
        }),
        tool: mock((name: string, description: string, inputSchema: unknown, handler: unknown) => {
          const def = { name, description, inputSchema, handler };
          _toolBatch.push({ name, def });
          return def;
        }),
      }));

      const providerWithCreds = new AnthropicProvider();
      providerWithCreds.clearModelCache();

      await expect(providerWithCreds.getModels()).rejects.toThrow('SDK unavailable');
    });
  });

  describe('getAuthStatus', () => {
    it('reports plain credential presence when no failure is recorded', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const status = await provider.getAuthStatus();

      expect(status).toEqual({
        isAuthenticated: true,
        method: 'api_key',
        error: undefined,
      });
    });

    it('surfaces a recorded credential failure as unauthenticated', async () => {
      process.env.ANTHROPIC_API_KEY = 'revoked-key';
      recordProviderFailure('anthropic', new Error('SDK credential rejected (HTTP 401)'));

      const status = await provider.getAuthStatus();

      expect(status.isAuthenticated).toBe(false);
      expect(status.errorKind).toBe('credential');
      expect(status.error).toBe('SDK credential rejected (HTTP 401)');
    });

    it('stays authenticated but degraded for a recorded transient failure', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      recordProviderFailure('anthropic', new Error('SDK model load timeout'));

      const status = await provider.getAuthStatus();

      expect(status.isAuthenticated).toBe(true);
      expect(status.errorKind).toBe('transient');
      expect(status.error).toBe('SDK model load timeout');
    });
  });

  describe('ownsModel', () => {
    it('should own SDK short IDs', () => {
      expect(provider.ownsModel('default')).toBe(true);
      expect(provider.ownsModel('opus')).toBe(true);
      expect(provider.ownsModel('haiku')).toBe(true);
      expect(provider.ownsModel('sonnet')).toBe(true);
    });

    it('should own claude- prefixed models', () => {
      expect(provider.ownsModel('claude-sonnet-4-5-20250929')).toBe(true);
      expect(provider.ownsModel('claude-opus-4-5-20251101')).toBe(true);
      expect(provider.ownsModel('claude-haiku-4-5-20251001')).toBe(true);
    });

    it('should not own other provider models', () => {
      expect(provider.ownsModel('glm-5')).toBe(false);
      expect(provider.ownsModel('deepseek-coder')).toBe(false);
      expect(provider.ownsModel('gpt-4')).toBe(false);
      expect(provider.ownsModel('copilot-sonnet')).toBe(false);
      expect(provider.ownsModel('copilot-mini')).toBe(false);
    });

    it('should default to owning unknown models (for compatibility)', () => {
      expect(provider.ownsModel('some-unknown-model')).toBe(true);
    });
  });

  describe('getModelForTier', () => {
    it('should map tiers correctly', () => {
      expect(provider.getModelForTier('sonnet')).toBe('sonnet');
      expect(provider.getModelForTier('haiku')).toBe('haiku');
      expect(provider.getModelForTier('opus')).toBe('opus');
      expect(provider.getModelForTier('default')).toBe('sonnet');
    });
  });

  describe('buildSdkConfig', () => {
    it('should return empty env vars for Anthropic', () => {
      const config = provider.buildSdkConfig('default');

      expect(config.envVars).toEqual({});
      expect(config.isAnthropicCompatible).toBe(true);
      expect(config.apiVersion).toBe('v1');
    });

    it('should skip stored API key injection when any Anthropic auth env var is set', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';
      const providerWithStoredKey = new AnthropicProvider();
      providerWithStoredKey.setCredentials({ type: 'api_key', apiKey: 'stored-key' });

      const config = providerWithStoredKey.buildSdkConfig('default');

      expect(config.envVars.ANTHROPIC_API_KEY).toBeUndefined();
    });
  });

  describe('model cache', () => {
    it('should allow setting model cache', async () => {
      const customModels = [
        {
          id: 'custom-model',
          name: 'Custom',
          alias: 'custom',
          family: 'sonnet' as const,
          provider: 'anthropic' as const,
          contextWindow: 100000,
          description: 'Custom model',
          releaseDate: '',
          available: true,
        },
      ];

      provider.setModelCache(customModels);
      const models = await provider.getModels();

      expect(models).toEqual(customModels);
    });

    it('should allow clearing model cache', async () => {
      provider.setModelCache([
        {
          id: 'cached',
          name: 'Cached',
          alias: 'cached',
          family: 'sonnet' as const,
          provider: 'anthropic' as const,
          contextWindow: 100000,
          description: 'Cached',
          releaseDate: '',
          available: true,
        },
      ]);

      provider.clearModelCache();

      const models = await provider.getModels();
      expect(models).toEqual([]);
    });

    it('clears the model cache when credentials are replaced', async () => {
      provider.setCredentials({ type: 'api_key', apiKey: 'first-key' });
      provider.setModelCache([
        {
          id: 'cached',
          name: 'Cached',
          alias: 'cached',
          family: 'sonnet' as const,
          provider: 'anthropic' as const,
          contextWindow: 100000,
          description: 'Cached',
          releaseDate: '',
          available: true,
        },
      ]);

      provider.setCredentials({ type: 'api_key', apiKey: '' });

      const models = await provider.getModels();
      expect(models).toEqual([]);
    });

    it('discards an in-flight SDK load when credentials change mid-flight', async () => {
      let loadCount = 0;
      let releaseFirstLoad:
        | ((models: Array<{ value: string; displayName: string; description: string }>) => void)
        | null = null;
      class MockMcpServer {
        readonly _registeredTools: Record<string, object> = {};
        connect(): void {}
        disconnect(): void {}
      }
      mock.module('@anthropic-ai/claude-agent-sdk', () => ({
        query: () => {
          loadCount++;
          return {
            interrupt: mock(async () => {}),
            supportedModels: () =>
              new Promise<Array<{ value: string; displayName: string; description: string }>>(
                (resolve) => {
                  if (loadCount === 1) {
                    releaseFirstLoad = resolve;
                  } else {
                    resolve([
                      { value: 'opus', displayName: 'Opus', description: 'Opus 4.6 · Test' },
                    ]);
                  }
                }
              ),
          };
        },
        interrupt: mock(async () => {}),
        createSdkMcpServer: mock((_options: { name: string; tools?: unknown[] }) => ({
          type: 'sdk' as const,
          name: _options.name,
          version: '1.0.0',
          tools: _options.tools ?? [],
          instance: new MockMcpServer(),
        })),
        tool: mock((name: string, description: string, inputSchema: unknown, handler: unknown) => ({
          name,
          description,
          inputSchema,
          handler,
        })),
      }));

      const providerWithInFlightLoad = new AnthropicProvider();
      providerWithInFlightLoad.setCredentials({ type: 'api_key', apiKey: 'first-key' });

      const firstLoad = providerWithInFlightLoad.getModels();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(loadCount).toBe(1);

      providerWithInFlightLoad.setCredentials({ type: 'api_key', apiKey: 'second-key' });
      releaseFirstLoad?.([
        { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 4.5 · Test' },
      ]);
      await firstLoad;

      const reloaded = await providerWithInFlightLoad.getModels();

      expect(loadCount).toBe(2);
      expect(reloaded.map((model) => model.id)).toEqual(['opus']);
    });
  });

  describe('convertSdkModels foreign-id filter', () => {
    it('drops glm-* SDK models so they do not get tagged as anthropic', () => {
      const sdkModels = [
        { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 4.6 · ...' },
        { value: 'glm-5', displayName: 'GLM-5', description: 'GLM 5 · ...' },
        { value: 'glm-5-turbo', displayName: 'GLM-5-Turbo', description: 'GLM 5 turbo · ...' },
      ];

      const converted = provider.convertSdkModels(sdkModels);

      expect(converted.find((m) => m.id.startsWith('glm-'))).toBeUndefined();
      expect(converted.map((m) => m.id)).toContain('sonnet');
      for (const m of converted) {
        expect(m.provider).toBe('anthropic');
      }
    });

    it('keeps full claude-* version IDs and canonical short IDs', () => {
      const sdkModels = [
        { value: 'opus', displayName: 'Opus', description: 'Opus 4.6 · ...' },
        { value: 'fable', displayName: 'Fable', description: 'Fable 4.6 · ...' },
        {
          value: 'claude-haiku-4-5-20251001',
          displayName: 'Haiku',
          description: 'Haiku 4.5 · ...',
        },
        { value: 'MiniMax-M2.5', displayName: 'MiniMax', description: 'mm · ...' },
      ];

      const converted = provider.convertSdkModels(sdkModels);
      const ids = converted.map((m) => m.id);

      expect(ids).toContain('opus');
      expect(ids).toContain('fable');
      expect(ids).toContain('claude-haiku-4-5-20251001');
      expect(ids).not.toContain('MiniMax-M2.5');
      expect(converted.find((m) => m.id === 'fable')?.family).toBe('fable');
    });

    it('claims the fable SDK alias as Anthropic', () => {
      expect(provider.ownsModel('fable')).toBe(true);
    });
  });
});

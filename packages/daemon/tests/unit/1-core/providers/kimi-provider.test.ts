/**
 * Unit tests for Kimi Provider
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  KimiProvider,
  KIMI_REGION_ENDPOINTS,
  resolveKimiRegion,
} from '../../../../src/lib/providers/kimi-provider';
import type {
  AnthropicMessagesBridgeServer,
  AnthropicMessagesBridgeConfig,
} from '../../../../src/lib/providers/anthropic-messages-bridge/server';

/**
 * Fake bridge factory that records calls and returns a stub server.
 * Avoids binding real TCP ports in unit tests.
 */
function createFakeBridgeFactory() {
  const calls: AnthropicMessagesBridgeConfig[] = [];
  let portCounter = 42000;
  const servers: { port: number; stop: () => void }[] = [];

  const factory = (config: AnthropicMessagesBridgeConfig): AnthropicMessagesBridgeServer => {
    calls.push(config);
    const port = portCounter++;
    const server = { port, stop: mock(() => {}) };
    servers.push(server);
    return server;
  };

  return { factory, calls, servers };
}

describe('KimiProvider', () => {
  let provider: KimiProvider;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.KIMI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
  });

  afterEach(async () => {
    await provider.shutdown();
    process.env = originalEnv;
  });

  describe('basic properties', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should have correct ID and display name', () => {
      expect(provider.id).toBe('kimi');
      expect(provider.displayName).toBe('Kimi (Moonshot AI)');
    });

    it('should have correct capabilities', () => {
      expect(provider.capabilities).toEqual({
        streaming: true,
        extendedThinking: true,
        maxContextWindow: 262144,
        functionCalling: true,
        vision: false,
        thinkingModes: 'on',
      });
    });
  });

  describe('isAvailable', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should return true when KIMI_API_KEY is set', () => {
      process.env.KIMI_API_KEY = 'test-key';
      expect(provider.isAvailable()).toBe(true);
    });

    it('should return true when MOONSHOT_API_KEY is set', () => {
      process.env.MOONSHOT_API_KEY = 'test-key';
      expect(provider.isAvailable()).toBe(true);
    });

    it('should prefer KIMI_API_KEY over MOONSHOT_API_KEY', () => {
      process.env.KIMI_API_KEY = 'kimi-key';
      process.env.MOONSHOT_API_KEY = 'moonshot-key';
      expect(provider.getApiKey()).toBe('kimi-key');
    });

    it('should prefer env API keys over stored credentials', () => {
      provider.setCredentials({ type: 'api_key', apiKey: 'stored-key' });
      process.env.KIMI_API_KEY = 'env-key';

      expect(provider.getApiKey()).toBe('env-key');
    });

    it('should return false when no API key is set', () => {
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('getModels', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should return Kimi models when API key is available', async () => {
      process.env.KIMI_API_KEY = 'test-key';

      const models = await provider.getModels();

      expect(models.map((m) => m.id)).toEqual(['kimi-for-coding']);
      expect(models.every((m) => m.provider === 'kimi')).toBe(true);
    });

    it('should return empty array when API key is not available', async () => {
      const models = await provider.getModels();
      expect(models).toEqual([]);
    });
  });

  describe('ownsModel', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should own kimi and moonshot model IDs', () => {
      expect(provider.ownsModel('kimi')).toBe(true);
      expect(provider.ownsModel('kimi-for-coding')).toBe(true);
      expect(provider.ownsModel('Kimi')).toBe(true);
      expect(provider.ownsModel('Kimi-For-Coding')).toBe(true);
      expect(provider.ownsModel('moonshot-v1-32k')).toBe(true);
    });

    it('should not own other provider models', () => {
      expect(provider.ownsModel('default')).toBe(false);
      expect(provider.ownsModel('glm-5')).toBe(false);
      expect(provider.ownsModel('claude-sonnet-4-5')).toBe(false);
    });
  });

  describe('getModelForTier', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should map all tiers to default Kimi model', () => {
      expect(provider.getModelForTier('haiku')).toBe('kimi-for-coding');
      expect(provider.getModelForTier('sonnet')).toBe('kimi-for-coding');
      expect(provider.getModelForTier('opus')).toBe('kimi-for-coding');
      expect(provider.getModelForTier('default')).toBe('kimi-for-coding');
    });
  });

  describe('buildSdkConfig', () => {
    it('should start bridge and route through it', () => {
      const { factory, calls } = createFakeBridgeFactory();
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider(process.env, factory);

      const config = provider.buildSdkConfig('kimi-for-coding');

      // Bridge was started with correct config
      expect(calls).toHaveLength(1);
      expect(calls[0].baseUrl).toBe('https://api.kimi.com/coding');
      expect(calls[0].apiKey).toBe('test-key');
      expect(calls[0].models).toEqual([
        {
          id: 'kimi-for-coding',
          display_name: 'Kimi For Coding',
          context_window: 262144,
          max_tokens: 32768,
        },
      ]);

      // SDK routes through the bridge
      expect(config.envVars.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // Blank both Anthropic auth env vars so ProviderService clears any
      // inherited Anthropic credentials. The bridge handles Kimi auth.
      expect(config.envVars.ANTHROPIC_API_KEY).toBe('');
      expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('');
      expect(config.envVars.API_TIMEOUT_MS).toBe('3000000');
      // CLAUDE_CODE_AUTO_COMPACT_WINDOW is explicitly cleared (empty string)
      // so a previous GLM/Codex query's value cannot leak into Kimi's SDK
      // subprocess. The SDK's PP() caps kimi-for-coding to 200k regardless,
      // so an inherited 262144 would still cap to 200k and fire ~60k too
      // early. SDK auto-compact is disabled via Options.settings; NeoKai's
      // fallback trigger handles compaction at the correct 85% of 262k.
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('');
      expect(config.envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-for-coding');
      expect(config.isAnthropicCompatible).toBe(true);
      expect(config.apiVersion).toBe('v1');
    });

    it('should reuse the same bridge for identical credentials', () => {
      const { factory, calls } = createFakeBridgeFactory();
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider(process.env, factory);

      provider.buildSdkConfig('kimi-for-coding');
      provider.buildSdkConfig('kimi-for-coding');

      // Only one bridge started
      expect(calls).toHaveLength(1);
    });

    it('should create separate bridges for different API keys', () => {
      const { factory, calls } = createFakeBridgeFactory();
      provider = new KimiProvider(process.env, factory);

      provider.buildSdkConfig('kimi-for-coding', { apiKey: 'key-a' });
      provider.buildSdkConfig('kimi-for-coding', { apiKey: 'key-b' });

      expect(calls).toHaveLength(2);
      expect(calls[0].apiKey).toBe('key-a');
      expect(calls[1].apiKey).toBe('key-b');
    });

    it('should create separate bridges for different base URLs', () => {
      const { factory, calls } = createFakeBridgeFactory();
      provider = new KimiProvider(process.env, factory);

      provider.buildSdkConfig('kimi-for-coding', {
        apiKey: 'key',
        baseUrl: 'https://api.kimi.com/coding',
      });
      provider.buildSdkConfig('kimi-for-coding', {
        apiKey: 'key',
        baseUrl: 'https://api.moonshot.cn/anthropic',
      });

      expect(calls).toHaveLength(2);
      expect(calls[0].baseUrl).toBe('https://api.kimi.com/coding');
      expect(calls[1].baseUrl).toBe('https://api.moonshot.cn/anthropic');
    });

    it('should normalize aliases to kimi-for-coding', () => {
      const { factory, calls } = createFakeBridgeFactory();
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider(process.env, factory);

      const config = provider.buildSdkConfig('kimi');

      expect(calls[0].models![0].id).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-for-coding');
    });

    it('should normalize mixed-case aliases to kimi-for-coding', () => {
      const { factory, calls } = createFakeBridgeFactory();
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider(process.env, factory);

      provider.buildSdkConfig('Kimi');

      expect(calls[0].models![0].id).toBe('kimi-for-coding');
    });

    it('should normalize moonshot- prefixed model IDs to kimi-for-coding', () => {
      const { factory, calls } = createFakeBridgeFactory();
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider(process.env, factory);

      provider.buildSdkConfig('moonshot-v1-32k');

      expect(calls[0].models![0].id).toBe('kimi-for-coding');
    });

    it('should use session config API key and base URL overrides', () => {
      const { factory, calls } = createFakeBridgeFactory();
      process.env.KIMI_API_KEY = 'env-key';
      provider = new KimiProvider(process.env, factory);

      const config = provider.buildSdkConfig('kimi-for-coding', {
        apiKey: 'session-key',
        baseUrl: 'https://api.moonshot.cn/anthropic',
      });

      expect(calls[0].baseUrl).toBe('https://api.moonshot.cn/anthropic');
      expect(calls[0].apiKey).toBe('session-key');
      // Both Anthropic auth env vars are blanked so inherited credentials are cleared
      expect(config.envVars.ANTHROPIC_API_KEY).toBe('');
      expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('');
    });

    it('should throw when no API key is configured', () => {
      const { factory } = createFakeBridgeFactory();
      provider = new KimiProvider(process.env, factory);

      expect(() => provider.buildSdkConfig('kimi-for-coding')).toThrow(
        'Kimi API key not configured'
      );
    });
  });

  describe('region resolution', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('exposes china + global endpoints in KIMI_REGION_ENDPOINTS', () => {
      expect(KIMI_REGION_ENDPOINTS.china.anthropicBaseUrl).toBe('https://api.kimi.com/coding');
      expect(KIMI_REGION_ENDPOINTS.china.openAiBaseUrl).toBe('https://api.kimi.com/coding/v1');
      expect(KIMI_REGION_ENDPOINTS.global.anthropicBaseUrl).toBe(
        'https://api.moonshot.ai/anthropic'
      );
      expect(KIMI_REGION_ENDPOINTS.global.openAiBaseUrl).toBe('https://api.moonshot.ai/v1');
    });

    it('resolveKimiRegion returns the region for valid inputs', () => {
      expect(resolveKimiRegion('china')).toBe('china');
      expect(resolveKimiRegion('global')).toBe('global');
    });

    it('resolveKimiRegion defaults to china for missing/invalid region', () => {
      expect(resolveKimiRegion(undefined)).toBe('china');
      expect(resolveKimiRegion(null)).toBe('china');
      expect(resolveKimiRegion('')).toBe('china');
      expect(resolveKimiRegion('us')).toBe('china');
      expect(resolveKimiRegion(42)).toBe('china');
    });

    it('static getBaseUrlForRegion returns the correct Anthropic-compatible URL', () => {
      expect(KimiProvider.getBaseUrlForRegion('china')).toBe('https://api.kimi.com/coding');
      expect(KimiProvider.getBaseUrlForRegion('global')).toBe('https://api.moonshot.ai/anthropic');
      // Default argument falls back to china.
      expect(KimiProvider.getBaseUrlForRegion()).toBe('https://api.kimi.com/coding');
    });

    it('static getOpenAiBaseUrlForRegion returns the correct OpenAI-compatible URL', () => {
      expect(KimiProvider.getOpenAiBaseUrlForRegion('china')).toBe(
        'https://api.kimi.com/coding/v1'
      );
      expect(KimiProvider.getOpenAiBaseUrlForRegion('global')).toBe('https://api.moonshot.ai/v1');
    });

    it('default provider region is china when unset', () => {
      expect(provider.getDefaultRegion()).toBe('china');
    });

    it('setDefaultRegion updates the provider-level default region', () => {
      provider.setDefaultRegion('global');
      expect(provider.getDefaultRegion()).toBe('global');
    });

    it('BASE_URL static stays on the China endpoint for backward compatibility', () => {
      // Legacy callers that still reference KimiProvider.BASE_URL must keep
      // resolving to api.kimi.com — existing credentials without a region
      // continue to work unchanged.
      expect(KimiProvider.BASE_URL).toBe('https://api.kimi.com/coding');
      expect(KimiProvider.OPENAI_BASE_URL).toBe('https://api.kimi.com/coding/v1');
    });
  });

  describe('buildSdkConfig region routing', () => {
    it('routes to the China endpoint when no region is configured', () => {
      const { factory, calls } = createFakeBridgeFactory();
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider(process.env, factory);

      provider.buildSdkConfig('kimi-for-coding');

      expect(calls).toHaveLength(1);
      expect(calls[0].baseUrl).toBe('https://api.kimi.com/coding');
    });

    it('routes to the Global endpoint when sessionConfig.region is global', () => {
      const { factory, calls } = createFakeBridgeFactory();
      provider = new KimiProvider(process.env, factory);

      provider.buildSdkConfig('kimi-for-coding', {
        apiKey: 'key',
        region: 'global',
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].baseUrl).toBe('https://api.moonshot.ai/anthropic');
    });

    it('routes to the China endpoint when sessionConfig.region is china', () => {
      const { factory, calls } = createFakeBridgeFactory();
      provider = new KimiProvider(process.env, factory);

      provider.buildSdkConfig('kimi-for-coding', {
        apiKey: 'key',
        region: 'china',
      });

      expect(calls[0].baseUrl).toBe('https://api.kimi.com/coding');
    });

    it('falls back to provider-level default region when sessionConfig omits region', () => {
      const { factory, calls } = createFakeBridgeFactory();
      provider = new KimiProvider(process.env, factory);
      // Simulate region loaded from ProviderRecord configJson by provider-sync.
      provider.setDefaultRegion('global');

      provider.buildSdkConfig('kimi-for-coding', { apiKey: 'key' });

      expect(calls[0].baseUrl).toBe('https://api.moonshot.ai/anthropic');
    });

    it('per-session region overrides provider-level default region', () => {
      const { factory, calls } = createFakeBridgeFactory();
      provider = new KimiProvider(process.env, factory);
      provider.setDefaultRegion('global');

      provider.buildSdkConfig('kimi-for-coding', { apiKey: 'key', region: 'china' });

      expect(calls[0].baseUrl).toBe('https://api.kimi.com/coding');
    });

    it('explicit sessionConfig.baseUrl overrides region selection', () => {
      const { factory, calls } = createFakeBridgeFactory();
      provider = new KimiProvider(process.env, factory);
      provider.setDefaultRegion('global');

      provider.buildSdkConfig('kimi-for-coding', {
        apiKey: 'key',
        baseUrl: 'https://custom.example.com/anthropic',
      });

      expect(calls[0].baseUrl).toBe('https://custom.example.com/anthropic');
    });

    it('invalid sessionConfig.region falls back to china (not global)', () => {
      const { factory, calls } = createFakeBridgeFactory();
      provider = new KimiProvider(process.env, factory);

      provider.buildSdkConfig('kimi-for-coding', {
        apiKey: 'key',
        region: 'us' as unknown,
      });

      expect(calls[0].baseUrl).toBe('https://api.kimi.com/coding');
    });

    it('creates separate bridges for different regions', () => {
      const { factory, calls } = createFakeBridgeFactory();
      provider = new KimiProvider(process.env, factory);

      provider.buildSdkConfig('kimi-for-coding', { apiKey: 'key', region: 'china' });
      provider.buildSdkConfig('kimi-for-coding', { apiKey: 'key', region: 'global' });

      expect(calls).toHaveLength(2);
      expect(calls[0].baseUrl).toBe('https://api.kimi.com/coding');
      expect(calls[1].baseUrl).toBe('https://api.moonshot.ai/anthropic');
    });
  });

  describe('translateModelIdForSdk', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should translate Kimi models to default', () => {
      expect(provider.translateModelIdForSdk('kimi-for-coding')).toBe('default');
    });
  });

  describe('static models', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should have correct static model definitions', () => {
      expect(KimiProvider.BASE_URL).toBe('https://api.kimi.com/coding');
      expect(KimiProvider.MODELS).toHaveLength(1);
      expect(KimiProvider.MODELS.find((m) => m.id === 'kimi-for-coding')?.contextWindow).toBe(
        262144
      );
    });

    it('should mark Kimi model with preferContextWindowMetadata', () => {
      // The SDK's PP() caps kimi-for-coding to 200k, but the real window is
      // 262k. The context-fetcher must trust metadata for the context bar.
      expect(KimiProvider.MODELS[0].preferContextWindowMetadata).toBe(true);
    });

    it('should expose moonshot-* provider aliases via providerAliasPrefixes', () => {
      // KimiProvider.ownsModel accepts any moonshot-* ID but model-service
      // lookups go through findInModels which checks id/alias/providerAliases/
      // providerAliasPrefixes. Without the prefix, sessions stored with a
      // moonshot-* ID have null modelInfo and NeoKai fallback compaction can't
      // compute a threshold.
      const providerAliases = KimiProvider.MODELS[0].providerAliases ?? [];
      const providerAliasPrefixes = KimiProvider.MODELS[0].providerAliasPrefixes ?? [];
      expect(providerAliases).toContain('KIMI');
      expect(providerAliasPrefixes).toContain('moonshot-');
    });
  });

  describe('getTitleGenerationModel', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should return kimi-for-coding', () => {
      expect(provider.getTitleGenerationModel()).toBe('kimi-for-coding');
    });
  });

  describe('getAuthStatus', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should return authenticated when API key is set', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      const status = await provider.getAuthStatus();
      expect(status.isAuthenticated).toBe(true);
      expect(status.method).toBe('api_key');
      expect(status.error).toBeUndefined();
    });

    it('should return not authenticated when no API key', async () => {
      const status = await provider.getAuthStatus();
      expect(status.isAuthenticated).toBe(false);
      expect(status.error).toContain('KIMI_API_KEY');
    });
  });

  describe('shutdown', () => {
    it('should stop all bridge servers on shutdown', async () => {
      const { factory, servers } = createFakeBridgeFactory();
      provider = new KimiProvider(process.env, factory);

      provider.buildSdkConfig('kimi-for-coding', { apiKey: 'key-a' });
      provider.buildSdkConfig('kimi-for-coding', { apiKey: 'key-b' });
      expect(servers).toHaveLength(2);

      await provider.shutdown();
      expect(servers[0].stop).toHaveBeenCalled();
      expect(servers[1].stop).toHaveBeenCalled();
    });

    it('should resolve without error when no bridge was started', async () => {
      provider = new KimiProvider();
      await expect(provider.shutdown()).resolves.toBeUndefined();
    });
  });
});

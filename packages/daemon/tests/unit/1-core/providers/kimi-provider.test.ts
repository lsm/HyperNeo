/**
 * Unit tests for Kimi Provider
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  KIMI_REGION_ENDPOINTS,
  KimiProvider,
  resolveKimiRegion,
} from '../../../../src/lib/providers/kimi-provider';

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
    /**
     * Build a provider whose credential probe always succeeds, so existing
     * tests that just want the static model list don't need to mock every
     * fetch call individually.
     */
    function makeProbeOkProvider(): KimiProvider {
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      return new KimiProvider(process.env, undefined, fetchImpl);
    }

    it('should return Kimi models when API key is available', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      provider = makeProbeOkProvider();

      const models = await provider.getModels();

      expect(models.map((m) => m.id)).toEqual(['kimi-for-coding']);
      expect(models.every((m) => m.provider === 'kimi')).toBe(true);
    });

    it('should return empty array when API key is not available', async () => {
      provider = makeProbeOkProvider();
      const models = await provider.getModels();
      expect(models).toEqual([]);
    });

    it('probes the upstream Anthropic-compatible endpoint with the API key', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      provider = new KimiProvider(process.env, undefined, fetchImpl);

      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = (fetchImpl.mock.calls[0] as [string, RequestInit]) ?? [];
      expect(url).toBe('https://api.kimi.com/coding/v1/messages');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('test-key');
      expect(headers.authorization).toBe('Bearer test-key');
    });

    it('probes the provider-level global endpoint and model when configured', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      provider = new KimiProvider(process.env, undefined, fetchImpl);
      provider.setDefaultRegion('global');

      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = (fetchImpl.mock.calls[0] as [string, RequestInit]) ?? [];
      expect(url).toBe('https://api.moonshot.ai/anthropic/v1/messages');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('kimi-k2.7-code');
    });

    it('throws when upstream rejects the API key (401)', async () => {
      process.env.KIMI_API_KEY = 'bad-key';
      const fetchImpl = mock(
        async () => new Response('unauthorized', { status: 401 })
      ) as unknown as typeof fetch;
      provider = new KimiProvider(process.env, undefined, fetchImpl);

      expect(provider.getModels()).rejects.toThrow('Kimi API key rejected (HTTP 401)');
    });

    it('throws when probe times out / network fails', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      const fetchImpl = mock(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;
      provider = new KimiProvider(process.env, undefined, fetchImpl);

      expect(provider.getModels()).rejects.toThrow('Kimi probe failed: ECONNREFUSED');
    });

    it('caches successful probe for 30s so repeated calls do not re-probe', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      provider = new KimiProvider(process.env, undefined, fetchImpl);

      await provider.getModels();
      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe('ownsModel', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should own kimi and moonshot model IDs', () => {
      expect(provider.ownsModel('kimi')).toBe(true);
      expect(provider.ownsModel('kimi-k2.7-code')).toBe(true);
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
    it('should route directly to the native Anthropic-compatible endpoint', () => {
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-for-coding');

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding');
      expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('test-key');
      expect(config.envVars.ANTHROPIC_API_KEY).toBeUndefined();
      expect(config.envVars.API_TIMEOUT_MS).toBe('3000000');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.CLAUDE_CODE_SUBAGENT_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ENABLE_TOOL_SEARCH).toBe('false');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('262144');
      expect(config.envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
      expect(config.isAnthropicCompatible).toBe(true);
      expect(config.apiVersion).toBe('v1');
    });

    it('should normalize aliases to China model by default', () => {
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi');

      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.CLAUDE_CODE_SUBAGENT_MODEL).toBe('kimi-for-coding');
    });

    it('should normalize mixed-case aliases to China model by default', () => {
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('Kimi');

      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding');
    });

    it('should normalize moonshot- prefixed model IDs to China model by default', () => {
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('moonshot-v1-32k');

      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding');
    });

    it('should use session config API key and base URL overrides', () => {
      process.env.KIMI_API_KEY = 'env-key';
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-for-coding', {
        apiKey: 'session-key',
        baseUrl: 'https://api.moonshot.cn/anthropic',
      });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.cn/anthropic');
      expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('session-key');
    });

    it('should throw when no API key is configured', () => {
      provider = new KimiProvider();

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
      expect(KIMI_REGION_ENDPOINTS.china.modelId).toBe('kimi-for-coding');
      expect(KIMI_REGION_ENDPOINTS.global.anthropicBaseUrl).toBe(
        'https://api.moonshot.ai/anthropic'
      );
      expect(KIMI_REGION_ENDPOINTS.global.openAiBaseUrl).toBe('https://api.moonshot.ai/v1');
      expect(KIMI_REGION_ENDPOINTS.global.modelId).toBe('kimi-k2.7-code');
    });

    it('resolveKimiRegion returns the region for valid inputs', () => {
      expect(resolveKimiRegion('china')).toBe('china');
      expect(resolveKimiRegion('global')).toBe('global');
    });

    it('resolveKimiRegion is case-insensitive for hand-crafted payloads', () => {
      expect(resolveKimiRegion('CHINA')).toBe('china');
      expect(resolveKimiRegion('Global')).toBe('global');
      expect(resolveKimiRegion('  Global  ')).toBe('china'); // whitespace not trimmed
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

    it('static getModelIdForRegion returns the correct region model ID', () => {
      expect(KimiProvider.getModelIdForRegion('china')).toBe('kimi-for-coding');
      expect(KimiProvider.getModelIdForRegion('global')).toBe('kimi-k2.7-code');
      expect(KimiProvider.getModelIdForRegion()).toBe('kimi-for-coding');
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
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-for-coding');

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
    });

    it('routes to the Global endpoint when sessionConfig.region is global', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-k2.7-code', {
        apiKey: 'key',
        region: 'global',
      });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
      expect(config.envVars.CLAUDE_CODE_SUBAGENT_MODEL).toBe('kimi-k2.7-code');
    });

    it('routes to the China endpoint when sessionConfig.region is china', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-k2.7-code', {
        apiKey: 'key',
        region: 'china',
      });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
    });

    it('falls back to provider-level default region when sessionConfig omits region', () => {
      provider = new KimiProvider();
      // Simulate region loaded from ProviderRecord configJson by provider-sync.
      provider.setDefaultRegion('global');

      const config = provider.buildSdkConfig('kimi-k2.7-code', { apiKey: 'key' });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
    });

    it('per-session region overrides provider-level default region', () => {
      provider = new KimiProvider();
      provider.setDefaultRegion('global');

      const config = provider.buildSdkConfig('kimi-k2.7-code', { apiKey: 'key', region: 'china' });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
    });

    it('explicit sessionConfig.baseUrl overrides region selection', () => {
      provider = new KimiProvider();
      provider.setDefaultRegion('global');

      const config = provider.buildSdkConfig('kimi-k2.7-code', {
        apiKey: 'key',
        baseUrl: 'https://custom.example.com/anthropic',
      });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://custom.example.com/anthropic');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
    });

    it('invalid sessionConfig.region falls back to china (not global)', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-k2.7-code', {
        apiKey: 'key',
        region: 'us' as unknown,
      });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
    });

    it('returns the selected native endpoint for each region', () => {
      provider = new KimiProvider();

      const chinaConfig = provider.buildSdkConfig('kimi-k2.7-code', {
        apiKey: 'key',
        region: 'china',
      });
      const globalConfig = provider.buildSdkConfig('kimi-k2.7-code', {
        apiKey: 'key',
        region: 'global',
      });

      expect(chinaConfig.envVars.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding');
      expect(chinaConfig.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
      expect(globalConfig.envVars.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
      expect(globalConfig.envVars.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
    });
  });

  describe('translateModelIdForSdk', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should return actual model ID to avoid settings.json overrides', () => {
      // Returns actual model ID instead of 'default' so ~/.claude/settings.json
      // ANTHROPIC_DEFAULT_SONNET_MODEL cannot redirect to other providers.
      expect(provider.translateModelIdForSdk('kimi-k2.7-code')).toBe('kimi-k2.7-code');
      expect(provider.translateModelIdForSdk('kimi-for-coding')).toBe('kimi-for-coding');
      expect(provider.translateModelIdForSdk('moonshot-v1-32k')).toBe('kimi-for-coding');
      expect(provider.translateModelIdForSdk('kimi')).toBe('kimi-for-coding');
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
      expect(KimiProvider.MODELS[0].preferContextWindowMetadata).toBe(true);
    });

    it('should expose moonshot-* provider aliases via providerAliasPrefixes', () => {
      // KimiProvider.ownsModel accepts any moonshot-* ID but model-service
      // lookups go through findInModels which checks id/alias/providerAliases/
      // providerAliasPrefixes. Without the prefix, sessions stored with a
      // moonshot-* ID have null modelInfo and HyperNeo fallback compaction can't
      // compute a threshold.
      const providerAliases = KimiProvider.MODELS[0].providerAliases ?? [];
      const providerAliasPrefixes = KimiProvider.MODELS[0].providerAliasPrefixes ?? [];
      expect(providerAliases).toContain('KIMI');
      expect(providerAliases).toContain('kimi-k2.7-code');
      expect(providerAliasPrefixes).toContain('moonshot-');
    });
  });

  describe('getTitleGenerationModel', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should return default China model', () => {
      expect(provider.getTitleGenerationModel()).toBe('kimi-for-coding');
    });

    it('provider service overrides helper SDK model from regional env routing', () => {
      provider.setDefaultRegion('global');
      const config = provider.buildSdkConfig(provider.getTitleGenerationModel(), { apiKey: 'key' });

      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
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
    it('should resolve without error', async () => {
      provider = new KimiProvider();
      await expect(provider.shutdown()).resolves.toBeUndefined();
    });
  });
});

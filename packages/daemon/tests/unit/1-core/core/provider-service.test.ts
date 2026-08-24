import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ProviderId, ProviderSessionConfig } from '@hyperneo/shared/provider';
import type { Session } from '@hyperneo/shared';
import type { ModelInfo } from '@hyperneo/shared';
import type { Provider, ProviderSdkConfig } from '@hyperneo/shared/provider';
import {
  ProviderService,
  getProviderService,
  mergeProviderEnvVars,
  resetProviderServiceInstance,
} from '../../../../src/lib/provider-service';
import {
  markBuiltInProviderDisabled,
  resetProviderFactory,
} from '../../../../src/lib/providers/factory';
import {
  ProviderRegistry,
  getProviderRegistry,
  resetProviderRegistry,
} from '../../../../src/lib/providers/registry';

class MockProvider implements Provider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities = {
    streaming: true,
    extendedThinking: false,
    maxContextWindow: 100000,
    functionCalling: true,
    vision: false,
  };

  private available: boolean;
  private modelPrefix: string;
  private models: ModelInfo[];

  constructor(
    id: string = 'mock',
    displayName: string = 'Mock Provider',
    available: boolean = true,
    modelPrefix: string = 'mock-'
  ) {
    this.id = id;
    this.displayName = displayName;
    this.available = available;
    this.modelPrefix = modelPrefix;
    this.models = [
      {
        id: `${modelPrefix}1`,
        name: 'Mock Model 1',
        alias: 'mock1',
        family: 'mock',
        provider: id,
        contextWindow: 100000,
        description: 'Mock model',
        releaseDate: '',
        available: true,
      },
    ];
  }

  isAvailable(): boolean {
    return this.available;
  }

  async getModels(): Promise<ModelInfo[]> {
    return this.models;
  }

  ownsModel(modelId: string): boolean {
    return modelId.toLowerCase().startsWith(this.modelPrefix);
  }

  getModelForTier(tier: string): string | undefined {
    if (tier === 'haiku') return `${this.modelPrefix}haiku`;
    return `${this.modelPrefix}1`;
  }

  buildSdkConfig(
    modelId: string,
    sessionConfig?: { apiKey?: string; baseUrl?: string }
  ): ProviderSdkConfig {
    return {
      envVars: {
        ANTHROPIC_BASE_URL: 'https://mock.api.com',
        ANTHROPIC_AUTH_TOKEN: sessionConfig?.apiKey || 'mock-api-key',
      },
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  translateModelIdForSdk(modelId: string): string {
    return modelId.replace(this.modelPrefix, 'translated-');
  }
}

class ThrowingMockProvider extends MockProvider {
  constructor() {
    super('throwing', 'Throwing Provider', true, 'throwing-');
  }

  buildSdkConfig(): ProviderSdkConfig {
    throw new Error('embedded server not started');
  }
}

class TitleOverrideMockProvider extends MockProvider {
  constructor() {
    super('title-override', 'Title Override Provider', true, 'title-');
  }

  getTitleGenerationModel(): string {
    return 'title-turbo';
  }
}

class RegionAwareTitleMockProvider extends MockProvider {
  readonly id = 'region-aware-title' as const;
  readonly displayName = 'Region Aware Title Provider';
  private defaultRegion: 'china' | 'global' = 'china';

  constructor() {
    super('region-aware-title', 'Region Aware Title Provider', true, 'kimi-');
  }

  setDefaultRegion(region: 'china' | 'global'): void {
    this.defaultRegion = region;
  }

  buildSdkConfig(_modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    const region = sessionConfig?.region === 'global' ? 'global' : this.defaultRegion;
    const modelId = region === 'global' ? 'kimi-k2.7-code' : 'kimi-for-coding';
    return {
      envVars: {
        ANTHROPIC_BASE_URL:
          region === 'global' ? 'https://api.moonshot.ai/anthropic' : 'https://api.kimi.com/coding',
        ANTHROPIC_MODEL: modelId,
      },
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  translateModelIdForSdk(modelId: string): string {
    return modelId;
  }
}

class BridgeMockProvider extends MockProvider {
  constructor() {
    super('bridge', 'Bridge Provider', true, 'bridge-');
  }

  buildSdkConfig(): ProviderSdkConfig {
    return {
      envVars: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:12345',
        ANTHROPIC_API_KEY: 'bridge-session-key',
        CLAUDE_CODE_OAUTH_TOKEN: '',
      },
      isAnthropicCompatible: true,
    };
  }
}

class GlmMockProvider extends MockProvider {
  readonly id = 'glm' as const;
  readonly displayName = 'GLM Provider';

  constructor(available: boolean = true) {
    super('glm', 'GLM Provider', available, 'glm-');
  }

  ownsModel(modelId: string): boolean {
    return modelId.toLowerCase().startsWith('glm-') || modelId.toLowerCase().includes('glm');
  }

  buildSdkConfig(
    modelId: string,
    sessionConfig?: { apiKey?: string; baseUrl?: string }
  ): ProviderSdkConfig {
    return {
      envVars: {
        ANTHROPIC_BASE_URL: 'https://api.glm.example.com',
        ANTHROPIC_AUTH_TOKEN: sessionConfig?.apiKey || process.env.GLM_API_KEY || 'glm-key',
        API_TIMEOUT_MS: '120000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4-flash',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4',
      },
      isAnthropicCompatible: true,
    };
  }
}

class CopilotMockProvider extends MockProvider {
  readonly id = 'anthropic-copilot' as const;
  readonly displayName = 'GitHub Copilot (Anthropic API)';

  constructor() {
    super('anthropic-copilot', 'GitHub Copilot (Anthropic API)', true, 'copilot-');
  }

  ownsModel(modelId: string): boolean {
    return modelId.toLowerCase().startsWith('copilot-') || modelId === 'claude-opus-4.6';
  }

  buildSdkConfig(): ProviderSdkConfig {
    return {
      envVars: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:54321',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-copilot-proxy:/workspace',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-opus-4.6',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4.6',
      },
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }
}

class SessionAwareBridgeMockProvider extends MockProvider {
  readonly id = 'session-aware' as const;
  readonly displayName = 'Session Aware Bridge';
  seenSessionConfigs: Array<{ workspacePath?: string; sessionId?: string }> = [];

  constructor() {
    super('session-aware', 'Session Aware Bridge', true, 'bridge-');
  }

  ownsModel(modelId: string): boolean {
    return modelId.toLowerCase().startsWith('bridge-');
  }

  buildSdkConfig(
    _modelId: string,
    sessionConfig?: { workspacePath?: string; sessionId?: string }
  ): ProviderSdkConfig {
    this.seenSessionConfigs.push({
      workspacePath: sessionConfig?.workspacePath,
      sessionId: sessionConfig?.sessionId,
    });
    return {
      envVars: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:60000',
        ANTHROPIC_API_KEY: `bridge-${sessionConfig?.sessionId ?? 'default'}`,
      },
      isAnthropicCompatible: true,
    };
  }
}

class AnthropicMockProvider extends MockProvider {
  readonly id = 'anthropic' as const;
  readonly displayName = 'Anthropic';

  constructor(
    available: boolean = true,
    private readonly envVars: Record<string, string> = {}
  ) {
    super('anthropic', 'Anthropic', available, 'claude-');
  }

  ownsModel(modelId: string): boolean {
    return (
      modelId.toLowerCase().startsWith('claude-') ||
      ['default', 'sonnet', 'haiku', 'opus'].includes(modelId.toLowerCase())
    );
  }

  buildSdkConfig(): ProviderSdkConfig {
    return {
      envVars: this.envVars,
      isAnthropicCompatible: true,
    };
  }

  translateModelIdForSdk(modelId: string): string {
    return modelId;
  }
}

describe('ProviderService', () => {
  let service: ProviderService;
  let registry: ProviderRegistry;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
      CLAUDE_CODE_SUBAGENT_MODEL: process.env.CLAUDE_CODE_SUBAGENT_MODEL,
      ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      GLM_API_KEY: process.env.GLM_API_KEY,
      ZHIPU_API_KEY: process.env.ZHIPU_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      KIMI_API_KEY: process.env.KIMI_API_KEY,
      MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
      API_TIMEOUT_MS: process.env.API_TIMEOUT_MS,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
        process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
      ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      PORT: process.env.PORT,
      HYPERNEO_PORT: process.env.HYPERNEO_PORT,
    };

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
    delete process.env.ENABLE_TOOL_SEARCH;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.GLM_API_KEY;
    delete process.env.ZHIPU_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.API_TIMEOUT_MS;
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    delete process.env.PORT;
    delete process.env.HYPERNEO_PORT;

    resetProviderRegistry();
    resetProviderFactory();
    markBuiltInProviderDisabled('anthropic-copilot');

    registry = new ProviderRegistry();
    registry.register(new AnthropicMockProvider(true));
    registry.register(new GlmMockProvider(true));

    service = new ProviderService();

    // @ts-expect-error - accessing private method for testing
    service.getRegistry = () => registry;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }

    resetProviderRegistry();
    resetProviderFactory();
  });

  describe('getDefaultProvider', () => {
    it('should return the default provider', async () => {
      const provider = await service.getDefaultProvider();
      expect(provider).toBe('anthropic');
    });
  });

  describe('getProviderApiKey', () => {
    it('should return ANTHROPIC_API_KEY for anthropic provider', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
      const key = service.getProviderApiKey('anthropic');
      expect(key).toBe('test-anthropic-key');
    });

    it('should return CLAUDE_CODE_OAUTH_TOKEN for anthropic if no API key', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
      const key = service.getProviderApiKey('anthropic');
      expect(key).toBe('test-oauth-token');
    });

    it('should return GLM_API_KEY for glm provider', async () => {
      process.env.GLM_API_KEY = 'test-glm-key';
      const key = service.getProviderApiKey('glm');
      expect(key).toBe('test-glm-key');
    });

    it('should return ZHIPU_API_KEY for glm if no GLM_API_KEY', async () => {
      process.env.ZHIPU_API_KEY = 'test-zhipu-key';
      const key = service.getProviderApiKey('glm');
      expect(key).toBe('test-zhipu-key');
    });

    it('should return OPENROUTER_API_KEY for openrouter provider', async () => {
      registry.register(new MockProvider('openrouter', 'OpenRouter', true, 'openrouter/'));
      process.env.OPENROUTER_API_KEY = 'sk-or-test';
      const key = service.getProviderApiKey('openrouter');
      expect(key).toBe('sk-or-test');
    });

    it('should return KIMI_API_KEY for kimi provider', async () => {
      registry.register(new MockProvider('kimi', 'Kimi', true, 'moonshot-'));
      process.env.KIMI_API_KEY = 'kimi-key';
      const key = service.getProviderApiKey('kimi');
      expect(key).toBe('kimi-key');
    });

    it('should return MOONSHOT_API_KEY for kimi if no KIMI_API_KEY', async () => {
      registry.register(new MockProvider('kimi', 'Kimi', true, 'moonshot-'));
      process.env.MOONSHOT_API_KEY = 'moonshot-key';
      const key = service.getProviderApiKey('kimi');
      expect(key).toBe('moonshot-key');
    });

    it('should return undefined for unknown provider', async () => {
      const key = service.getProviderApiKey('unknown' as unknown as ProviderId);
      expect(key).toBeUndefined();
    });

    it('should return undefined for unregistered provider', async () => {
      registry.clear();
      const key = service.getProviderApiKey('anthropic');
      expect(key).toBeUndefined();
    });
  });

  describe('isProviderAvailable', () => {
    it('should return true for available provider', async () => {
      const available = await service.isProviderAvailable('anthropic');
      expect(available).toBe(true);
    });

    it('should return false for unavailable provider', async () => {
      registry.clear();
      registry.register(new AnthropicMockProvider(false));

      const available = await service.isProviderAvailable('anthropic');
      expect(available).toBe(false);
    });

    it('should return false for unknown provider', async () => {
      const available = await service.isProviderAvailable('unknown' as unknown as ProviderId);
      expect(available).toBe(false);
    });
  });

  describe('getProviderInfo', () => {
    it('should return provider info for registered provider', async () => {
      const info = await service.getProviderInfo('anthropic');

      expect(info.id).toBe('anthropic');
      expect(info.name).toBe('Anthropic');
      expect(info.available).toBe(true);
      expect(info.models).toBeDefined();
    });

    it('should return default info for unknown provider', async () => {
      const info = await service.getProviderInfo('unknown' as unknown as ProviderId);

      expect(info.id).toBe('unknown');
      expect(info.name).toBe('unknown');
      expect(info.available).toBe(false);
      expect(info.models).toEqual([]);
    });

    it('should include base URL from SDK config', async () => {
      const info = await service.getProviderInfo('glm');

      expect(info.baseUrl).toBe('https://api.glm.example.com');
    });
  });

  describe('getAvailableProviders', () => {
    it('should return all registered providers with availability status', async () => {
      const providers = await service.getAvailableProviders();

      expect(providers.length).toBe(2);
      expect(providers.map((p) => p.id)).toContain('anthropic');
      expect(providers.map((p) => p.id)).toContain('glm');
    });

    it('should include availability status for each provider', async () => {
      registry.clear();
      registry.register(new AnthropicMockProvider(true));
      registry.register(new GlmMockProvider(false));

      const providers = await service.getAvailableProviders();

      expect(providers.length).toBe(2);

      const anthropicProvider = providers.find((p) => p.id === 'anthropic');
      const glmProvider = providers.find((p) => p.id === 'glm');

      expect(anthropicProvider?.available).toBe(true);
      expect(glmProvider?.available).toBe(false);
    });
  });

  describe('validateProviderSwitch', () => {
    it('should validate available provider', async () => {
      const result = await service.validateProviderSwitch('anthropic');
      expect(result.valid).toBe(true);
    });

    it('should reject unavailable provider without API key', async () => {
      registry.clear();
      registry.register(new GlmMockProvider(false));

      const result = await service.validateProviderSwitch('glm');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not available');
    });

    it('should accept unavailable provider with API key', async () => {
      registry.clear();
      registry.register(new GlmMockProvider(false));

      const result = await service.validateProviderSwitch('glm', 'test-key');
      expect(result.valid).toBe(true);
    });
  });

  describe('getDefaultModelForProvider', () => {
    it('should return default model for provider', async () => {
      const model = await service.getDefaultModelForProvider('glm');
      expect(model).toBe('glm-1');
    });

    it('should return "default" for unknown provider', async () => {
      const model = await service.getDefaultModelForProvider('unknown' as unknown as ProviderId);
      expect(model).toBe('default');
    });
  });

  describe('getTitleGenerationModel', () => {
    it('should return translated session model when provider has no title override', async () => {
      const model = await service.getTitleGenerationModel('glm', 'glm-4.7');

      expect(model).toBe('translated-4.7');
    });

    it('should return translated provider title override when configured', async () => {
      registry.register(new TitleOverrideMockProvider());

      const model = await service.getTitleGenerationModel('title-override', 'title-1');

      expect(model).toBe('translated-turbo');
    });

    it('should translate GLM title override to an SDK-compatible model', async () => {
      const provider = registry.get('glm') as GlmMockProvider;
      provider.getTitleGenerationModel = () => 'glm-5-turbo';

      const model = await service.getTitleGenerationModel('glm', 'glm-4.7');

      expect(model).toBe('translated-5-turbo');
    });

    it('should use provider-routed model env for region-aware title generation', async () => {
      const provider = new RegionAwareTitleMockProvider();
      provider.setDefaultRegion('global');
      registry.register(provider);

      const model = await service.getTitleGenerationModel('region-aware-title', 'kimi-for-coding');

      expect(model).toBe('kimi-k2.7-code');
    });

    it('falls back to the first curated model when the title override is curated out', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      globalRegistry.register(new TitleOverrideMockProvider());
      globalRegistry.setCuratedModels('title-override', [{ id: 'title-1' }]);

      const model = await realService.getTitleGenerationModel('title-override', 'title-9');

      expect(model).toBe('translated-1');
    });

    it('keeps the session model fallback when no curation is configured', async () => {
      const model = await service.getTitleGenerationModel('glm', 'glm-4.7');

      expect(model).toBe('translated-4.7');
    });

    it('falls back to the first curated model when the session model is curated out', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      globalRegistry.register(new GlmMockProvider());
      globalRegistry.setCuratedModels('glm', [{ id: 'glm-1' }]);

      const model = await realService.getTitleGenerationModel('glm', 'glm-4.7');

      expect(model).toBe('translated-1');
    });

    it('falls back to a visible curated model when a listed title override leaves the catalog', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      globalRegistry.register(new TitleOverrideMockProvider());
      globalRegistry.setCuratedModels('title-override', [{ id: 'title-turbo' }, { id: 'title-1' }]);

      const model = await realService.getTitleGenerationModel('title-override', 'title-9');

      expect(model).toBe('translated-1');
    });

    it('accepts a session-model alias that resolves to a curated catalog model', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      const provider = new GlmMockProvider();
      const baseModels = await provider.getModels();
      provider.getModels = async () => [
        ...baseModels,
        {
          id: 'glm-5',
          name: 'GLM-5',
          alias: 'glm',
          family: 'glm',
          provider: 'glm',
          contextWindow: 200000,
          description: 'GLM-5',
          releaseDate: '',
          available: true,
        },
      ];
      globalRegistry.register(provider);
      globalRegistry.setCuratedModels('glm', [{ id: 'glm-5' }]);

      const model = await realService.getTitleGenerationModel('glm', 'glm');

      expect(model).toBe('glm');
    });

    it('accepts an uncached alias of a curated model on a dynamically discovered provider', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      globalRegistry.register({
        id: 'ollama',
        displayName: 'Ollama',
        isAvailable: () => true,
        getModels: async () => [
          {
            id: 'ollama-qwen',
            name: 'Qwen',
            alias: 'qwen3',
            family: 'qwen',
            provider: 'ollama',
            contextWindow: 128000,
            description: 'Qwen',
            releaseDate: '',
            available: true,
          },
        ],
        ownsModel: () => false,
        getModelForTier: () => undefined,
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
      } as unknown as Parameters<typeof globalRegistry.register>[0]);
      globalRegistry.setCuratedModels('ollama', [{ id: 'ollama-qwen' }]);

      const model = await realService.getTitleGenerationModel('ollama', 'qwen3');

      expect(model).toBe('qwen3');
    });

    it('returns null when curation is explicitly empty', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      globalRegistry.register(new TitleOverrideMockProvider());
      globalRegistry.setCuratedModels('title-override', []);

      const model = await realService.getTitleGenerationModel('title-override', 'title-9');

      expect(model).toBeNull();
    });
  });

  describe('getTitleGenerationConfig', () => {
    it('should return config for registered provider', async () => {
      const config = await service.getTitleGenerationConfig('glm');

      expect(config?.modelId).toBe('glm-haiku');
      expect(config?.baseUrl).toBe('https://api.glm.example.com');
      expect(config?.apiVersion).toBe('v1');
    });

    it('should return fallback config for unknown provider', async () => {
      const config = await service.getTitleGenerationConfig('unknown' as unknown as ProviderId);

      expect(config?.modelId).toBe('haiku');
      expect(config?.baseUrl).toBe('https://api.anthropic.com');
      expect(config?.apiVersion).toBe('v1');
    });

    it('should return defaults when buildSdkConfig throws (e.g. server not yet started)', async () => {
      registry.register(new ThrowingMockProvider());

      const config = await service.getTitleGenerationConfig('throwing' as unknown as ProviderId);

      expect(config?.baseUrl).toBe('https://api.anthropic.com');
      expect(config?.apiVersion).toBe('v1');
    });

    it('should return provider-routed title model for region-aware providers', async () => {
      const provider = new RegionAwareTitleMockProvider();
      provider.setDefaultRegion('global');
      registry.register(provider);

      const config = await service.getTitleGenerationConfig('region-aware-title' as ProviderId);

      expect(config?.modelId).toBe('kimi-k2.7-code');
      expect(config?.baseUrl).toBe('https://api.moonshot.ai/anthropic');
      expect(config?.apiVersion).toBe('v1');
    });

    it('uses the tier fallback when the title override is curated out', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      const provider = new TitleOverrideMockProvider();
      const baseModels = await provider.getModels();
      provider.getModels = async () => [
        ...baseModels,
        {
          id: 'title-haiku',
          name: 'Title Haiku',
          alias: 'title-haiku',
          family: 'mock',
          provider: 'title-override',
          contextWindow: 100000,
          description: 'Mock model',
          releaseDate: '',
          available: true,
        },
      ];
      globalRegistry.register(provider);
      globalRegistry.setCuratedModels('title-override', [{ id: 'title-haiku' }, { id: 'title-1' }]);

      const config = await realService.getTitleGenerationConfig('title-override' as ProviderId);

      expect(config?.modelId).toBe('title-haiku');
      expect(config?.baseUrl).toBe('https://mock.api.com');
    });

    it('skips a curated-listed title override that is missing from the provider catalog', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      globalRegistry.register(new TitleOverrideMockProvider());
      globalRegistry.setCuratedModels('title-override', [
        { id: 'title-turbo' },
        { id: 'title-haiku' },
        { id: 'title-1' },
      ]);

      const config = await realService.getTitleGenerationConfig('title-override' as ProviderId);

      expect(config?.modelId).toBe('title-1');
      expect(config?.baseUrl).toBe('https://mock.api.com');
    });

    it('falls back to the first curated model when title override and tier fallback are curated out', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      globalRegistry.register(new TitleOverrideMockProvider());
      globalRegistry.setCuratedModels('title-override', [{ id: 'title-1' }]);

      const config = await realService.getTitleGenerationConfig('title-override' as ProviderId);

      expect(config?.modelId).toBe('title-1');
      expect(config?.baseUrl).toBe('https://mock.api.com');
    });

    it('returns null when curation is explicitly empty', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      globalRegistry.register(new TitleOverrideMockProvider());
      globalRegistry.setCuratedModels('title-override', []);

      const config = await realService.getTitleGenerationConfig('title-override' as ProviderId);

      expect(config).toBeNull();
    });

    it('uses the provider cached catalog when model discovery fails', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      globalRegistry.register({
        id: 'custom-endpoint',
        displayName: 'Custom Endpoint',
        isAvailable: () => true,
        getModels: async () => {
          throw new Error('probe route missing');
        },
        getCachedModels: () => [
          {
            id: 'custom-turbo',
            name: 'Custom Turbo',
            alias: 'custom-turbo',
            family: 'custom',
            provider: 'custom-endpoint',
            contextWindow: 128000,
            description: 'Custom Turbo',
            releaseDate: '',
            available: true,
          },
          {
            id: 'custom-1',
            name: 'Custom Model 1',
            alias: 'custom1',
            family: 'custom',
            provider: 'custom-endpoint',
            contextWindow: 128000,
            description: 'Custom Model 1',
            releaseDate: '',
            available: true,
          },
        ],
        ownsModel: () => false,
        getModelForTier: () => undefined,
        getTitleGenerationModel: () => 'custom-turbo',
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
      } as unknown as Parameters<typeof globalRegistry.register>[0]);
      globalRegistry.setCuratedModels('custom-endpoint', [
        { id: 'custom-turbo' },
        { id: 'custom-1' },
      ]);

      const config = await realService.getTitleGenerationConfig('custom-endpoint' as ProviderId);

      expect(config?.modelId).toBe('custom-turbo');
    });

    it('treats an empty catalog response as failed discovery', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      globalRegistry.register({
        id: 'custom-endpoint',
        displayName: 'Custom Endpoint',
        isAvailable: () => true,
        getModels: async () => [],
        getCachedModels: () => [
          {
            id: 'custom-turbo',
            name: 'Custom Turbo',
            alias: 'custom-turbo',
            family: 'custom',
            provider: 'custom-endpoint',
            contextWindow: 128000,
            description: 'Custom Turbo',
            releaseDate: '',
            available: true,
          },
          {
            id: 'custom-1',
            name: 'Custom Model 1',
            alias: 'custom1',
            family: 'custom',
            provider: 'custom-endpoint',
            contextWindow: 128000,
            description: 'Custom Model 1',
            releaseDate: '',
            available: true,
          },
        ],
        ownsModel: () => false,
        getModelForTier: () => undefined,
        getTitleGenerationModel: () => 'custom-turbo',
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
      } as unknown as Parameters<typeof globalRegistry.register>[0]);
      globalRegistry.setCuratedModels('custom-endpoint', [
        { id: 'custom-turbo' },
        { id: 'custom-1' },
      ]);

      const config = await realService.getTitleGenerationConfig('custom-endpoint' as ProviderId);

      expect(config?.modelId).toBe('custom-turbo');
    });

    it('falls back to static metadata when discovery throws without a provider cache', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      globalRegistry.register({
        id: 'glm',
        displayName: 'GLM',
        isAvailable: () => true,
        getModels: async () => {
          throw new Error('discovery timeout');
        },
        ownsModel: () => false,
        getModelForTier: () => undefined,
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
      } as unknown as Parameters<typeof globalRegistry.register>[0]);
      globalRegistry.setCuratedModels('glm', [{ id: 'glm-5' }]);

      const config = await realService.getTitleGenerationConfig('glm');

      expect(config?.modelId).toBe('glm-5');
    });

    it('fetches the provider catalog once per title selection', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      let fetchCount = 0;
      globalRegistry.register({
        id: 'custom-endpoint',
        displayName: 'Custom Endpoint',
        isAvailable: () => true,
        getModels: async () => {
          fetchCount += 1;
          return [
            {
              id: 'custom-turbo',
              name: 'Custom Turbo',
              alias: 'custom-turbo',
              family: 'custom',
              provider: 'custom-endpoint',
              contextWindow: 128000,
              description: 'Custom Turbo',
              releaseDate: '',
              available: true,
            },
            {
              id: 'custom-1',
              name: 'Custom Model 1',
              alias: 'custom1',
              family: 'custom',
              provider: 'custom-endpoint',
              contextWindow: 128000,
              description: 'Custom Model 1',
              releaseDate: '',
              available: true,
            },
          ];
        },
        ownsModel: () => false,
        getModelForTier: () => undefined,
        getTitleGenerationModel: () => 'custom-turbo',
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
      } as unknown as Parameters<typeof globalRegistry.register>[0]);
      globalRegistry.setCuratedModels('custom-endpoint', [
        { id: 'custom-turbo' },
        { id: 'custom-1' },
      ]);

      const config = await realService.getTitleGenerationConfig('custom-endpoint' as ProviderId);

      expect(config?.modelId).toBe('custom-turbo');
      expect(fetchCount).toBe(1);
    });

    it('re-reads curation after catalog discovery', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      const provider = new TitleOverrideMockProvider();
      const baseModels = await provider.getModels();
      provider.getModels = async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [
          ...baseModels,
          {
            id: 'title-haiku',
            name: 'Title Haiku',
            alias: 'title-haiku',
            family: 'mock',
            provider: 'title-override',
            contextWindow: 100000,
            description: 'Mock model',
            releaseDate: '',
            available: true,
          },
        ];
      };
      globalRegistry.register(provider);
      globalRegistry.setCuratedModels('title-override', [{ id: 'title-haiku' }, { id: 'title-1' }]);

      const pending = realService.getTitleGenerationConfig('title-override' as ProviderId);
      globalRegistry.setCuratedModels('title-override', [{ id: 'title-1' }]);

      const config = await pending;

      expect(config?.modelId).toBe('title-1');
    });
  });

  describe('getCheapTierModel', () => {
    it('returns the provider title override when no curation is configured', async () => {
      registry.register(new TitleOverrideMockProvider());

      expect(await service.getCheapTierModel('title-override')).toBe('title-turbo');
    });

    it('skips curated-out candidates and falls back to the first curated model', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      globalRegistry.register(new TitleOverrideMockProvider());
      globalRegistry.setCuratedModels('title-override', [{ id: 'title-1' }]);

      expect(await realService.getCheapTierModel('title-override')).toBe('title-1');
    });

    it('returns null when curation is explicitly empty', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      globalRegistry.register(new TitleOverrideMockProvider());
      globalRegistry.setCuratedModels('title-override', []);

      expect(await realService.getCheapTierModel('title-override')).toBeNull();
    });

    it('skips stale curated entries missing from the provider catalog', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      globalRegistry.register(new TitleOverrideMockProvider());
      globalRegistry.setCuratedModels('title-override', [{ id: 'title-stale' }, { id: 'title-1' }]);

      expect(await realService.getCheapTierModel('title-override')).toBe('title-1');
    });

    it('skips curated-listed preferred candidates missing from the provider catalog', async () => {
      const globalRegistry = getProviderRegistry();
      const realService = new ProviderService();
      globalRegistry.register(new TitleOverrideMockProvider());
      globalRegistry.setCuratedModels('title-override', [
        { id: 'title-turbo' },
        { id: 'title-haiku' },
        { id: 'title-1' },
      ]);

      expect(await realService.getCheapTierModel('title-override')).toBe('title-1');
    });
  });

  describe('isModelValidForProvider', () => {
    it('should return true for valid model', async () => {
      const valid = await service.isModelValidForProvider('glm', 'glm-4');
      expect(valid).toBe(true);
    });

    it('should return false for invalid model', async () => {
      const valid = await service.isModelValidForProvider('glm', 'claude-3-opus');
      expect(valid).toBe(false);
    });

    it('should return false for unknown provider', async () => {
      const valid = await service.isModelValidForProvider(
        'unknown' as unknown as ProviderId,
        'any-model'
      );
      expect(valid).toBe(false);
    });
  });

  describe('getEnvVarsForModel', () => {
    it('should return empty object for anthropic model', async () => {
      const envVars = await service.getEnvVarsForModel('claude-3-opus', 'anthropic');
      expect(envVars).toEqual({});
    });

    it('should return env vars for GLM model', async () => {
      const envVars = await service.getEnvVarsForModel('glm-4', 'glm');

      expect(envVars.ANTHROPIC_BASE_URL).toBe('https://api.glm.example.com');
      expect(envVars.API_TIMEOUT_MS).toBe('120000');
    });

    it('returns stored Anthropic API key env for Anthropic models', async () => {
      registry.clear();
      registry.register(new AnthropicMockProvider(true, { ANTHROPIC_API_KEY: 'stored-key' }));

      const envVars = await service.getEnvVarsForModel('claude-3-opus', 'anthropic');

      expect(envVars.ANTHROPIC_API_KEY).toBe('stored-key');
    });

    it('returns stored Anthropic OAuth env for Anthropic models', async () => {
      registry.clear();
      registry.register(
        new AnthropicMockProvider(true, { CLAUDE_CODE_OAUTH_TOKEN: 'stored-oauth-token' })
      );

      const envVars = await service.getEnvVarsForModel('claude-3-opus', 'anthropic');

      expect(envVars.CLAUDE_CODE_OAUTH_TOKEN).toBe('stored-oauth-token');
    });

    it('should return empty object for unknown provider', async () => {
      const envVars = await service.getEnvVarsForModel('unknown-model', 'anthropic');
      expect(envVars).toEqual({});
    });

    it('should return {} without throwing when buildSdkConfig throws (e.g. server not yet started)', async () => {
      registry.register(new ThrowingMockProvider());

      const envVars = await service.getEnvVarsForModel('throwing-model', 'throwing');
      expect(envVars).toEqual({});
    });

    it('uses explicit providerId to route to the correct provider for colliding model IDs', async () => {
      registry.register(new CopilotMockProvider());

      const envVarsAnthropic = await service.getEnvVarsForModel('claude-opus-4.6', 'anthropic');
      expect(envVarsAnthropic.ANTHROPIC_BASE_URL).toBeUndefined();

      const envVarsWithId = await service.getEnvVarsForModel(
        'claude-opus-4.6',
        'anthropic-copilot'
      );
      expect(envVarsWithId.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:54321');
    });
  });

  describe('getProviderEnvVars', () => {
    it('should return empty object for anthropic session', async () => {
      const session: Session = {
        id: 'test-session',
        title: 'Test',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-3-opus',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'anthropic',
        },
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
        },
      };

      const envVars = service.getProviderEnvVars(session);
      expect(envVars).toEqual({});
    });

    it('returns stored Anthropic API key env for Anthropic session', async () => {
      registry.clear();
      registry.register(new AnthropicMockProvider(true, { ANTHROPIC_API_KEY: 'stored-key' }));
      const session: Session = {
        id: 'test-session',
        title: 'Test',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-3-opus',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'anthropic',
        },
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
        },
      };

      const envVars = service.getProviderEnvVars(session);

      expect(envVars.ANTHROPIC_API_KEY).toBe('stored-key');
    });

    it('returns stored Anthropic OAuth env for Anthropic session', async () => {
      registry.clear();
      registry.register(
        new AnthropicMockProvider(true, { CLAUDE_CODE_OAUTH_TOKEN: 'stored-oauth-token' })
      );
      const session: Session = {
        id: 'test-session',
        title: 'Test',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-3-opus',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'anthropic',
        },
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
        },
      };

      const envVars = service.getProviderEnvVars(session);

      expect(envVars.CLAUDE_CODE_OAUTH_TOKEN).toBe('stored-oauth-token');
    });

    it('should return env vars for GLM session', async () => {
      const session: Session = {
        id: 'test-session',
        title: 'Test',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'glm-4',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'glm',
        },
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
        },
      };

      const envVars = service.getProviderEnvVars(session);
      expect(envVars.ANTHROPIC_BASE_URL).toBe('https://api.glm.example.com');
    });

    it('should use session config API key override', async () => {
      const session: Session = {
        id: 'test-session',
        title: 'Test',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'glm-4',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'glm',
          providerConfig: {
            apiKey: 'custom-api-key',
          },
        },
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
        },
      };

      const envVars = service.getProviderEnvVars(session);
      expect(envVars.ANTHROPIC_AUTH_TOKEN).toBe('custom-api-key');
    });

    it('should return {} without throwing when buildSdkConfig throws (e.g. server not yet started)', async () => {
      registry.register(new ThrowingMockProvider());

      const session: Session = {
        id: 'test-session',
        title: 'Test',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'throwing-1',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'throwing' as unknown as import('@hyperneo/shared/provider').ProviderId,
        },
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
        },
      };

      const envVars = service.getProviderEnvVars(session);
      expect(envVars).toEqual({});
    });

    it('passes session id and effective worktree path to session-aware providers', async () => {
      const provider = new SessionAwareBridgeMockProvider();
      registry.register(provider);
      const session: Session = {
        id: 'neo-session-123',
        title: 'Test',
        workspacePath: '/repo/root',
        worktree: {
          worktreePath: '/repo/worktrees/neo-session-123',
          mainRepoPath: '/repo/root',
          branch: 'codex/test',
        },
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'bridge-model',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'session-aware' as unknown as import('@hyperneo/shared/provider').ProviderId,
        },
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
        },
      };

      const envVars = service.getProviderEnvVars(session);

      expect(envVars.ANTHROPIC_API_KEY).toBe('bridge-neo-session-123');
      expect(provider.seenSessionConfigs.at(-1)).toEqual({
        sessionId: 'neo-session-123',
        workspacePath: '/repo/worktrees/neo-session-123',
      });
    });
  });

  describe('applyEnvVarsToProcess', () => {
    it('should return empty object for anthropic model', async () => {
      const original = await service.applyEnvVarsToProcess('claude-3-opus', 'anthropic');
      expect(original).toEqual({});
    });

    it('should clear leaked GLM routing vars for anthropic model without clearing OAuth auth', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.glm.example.com';
      process.env.API_TIMEOUT_MS = '120000';
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-4';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'user-oauth-token';

      const original = await service.applyEnvVarsToProcess('claude-3-opus', 'anthropic');

      expect(original.ANTHROPIC_BASE_URL).toBe('https://api.glm.example.com');
      expect(original.API_TIMEOUT_MS).toBe('120000');
      expect(original.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-4');
      expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(process.env.API_TIMEOUT_MS).toBeUndefined();
      expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('user-oauth-token');
    });

    it('should apply GLM env vars and return original values', async () => {
      process.env.ANTHROPIC_AUTH_TOKEN = 'original-token';
      process.env.ANTHROPIC_BASE_URL = 'original-url';

      const original = await service.applyEnvVarsToProcess('glm-4', 'glm');

      expect(original.ANTHROPIC_AUTH_TOKEN).toBe('original-token');
      expect(original.ANTHROPIC_BASE_URL).toBe('original-url');

      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.glm.example.com');
    });

    it('applies session-scoped bridge env vars from the full session', async () => {
      const provider = new SessionAwareBridgeMockProvider();
      registry.register(provider);
      const session: Session = {
        id: 'neo-session-456',
        title: 'Test',
        workspacePath: '/repo/root',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'bridge-model',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'session-aware' as unknown as import('@hyperneo/shared/provider').ProviderId,
        },
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
        },
      };

      const original = service.applyEnvVarsToProcessForSession(session);

      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('bridge-neo-session-456');
      expect(process.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:60000');
      expect(provider.seenSessionConfigs.at(-1)).toEqual({
        sessionId: 'neo-session-456',
        workspacePath: '/repo/root',
      });

      service.restoreEnvVars(original);
    });

    it('applies provider-managed model env vars and restores them', async () => {
      registry.clear();
      registry.register(
        new AnthropicMockProvider(true, {
          ANTHROPIC_MODEL: 'kimi-k2.7-code',
          CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-k2.7-code',
          ENABLE_TOOL_SEARCH: 'false',
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
        })
      );
      process.env.ANTHROPIC_MODEL = 'wrong-model';
      process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'wrong-subagent';
      process.env.ENABLE_TOOL_SEARCH = 'true';
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '200000';

      const original = await service.applyEnvVarsToProcess('claude-3-opus', 'anthropic');

      expect(process.env.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
      expect(process.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('kimi-k2.7-code');
      expect(process.env.ENABLE_TOOL_SEARCH).toBe('false');
      expect(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('262144');
      expect(original.ANTHROPIC_MODEL).toBe('wrong-model');
      expect(original.CLAUDE_CODE_SUBAGENT_MODEL).toBe('wrong-subagent');
      expect(original.ENABLE_TOOL_SEARCH).toBe('true');
      expect(original.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('200000');

      service.restoreEnvVars(original);
      expect(process.env.ANTHROPIC_MODEL).toBe('wrong-model');
      expect(process.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('wrong-subagent');
      expect(process.env.ENABLE_TOOL_SEARCH).toBe('true');
      expect(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('200000');
    });

    it('clears CLAUDE_CODE_OAUTH_TOKEN when provider returns empty-string sentinel, restores on restoreEnvVars', async () => {
      registry.register(new BridgeMockProvider());
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'real-oauth-token';

      const original = await service.applyEnvVarsToProcess('bridge-model', 'bridge');

      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(original.CLAUDE_CODE_OAUTH_TOKEN).toBe('real-oauth-token');
      expect(process.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:12345');

      service.restoreEnvVars(original);
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('real-oauth-token');
    });

    it('blanks ANTHROPIC_API_KEY when provider returns empty-string sentinel, restores on restoreEnvVars', async () => {
      registry.register(new CopilotMockProvider());
      process.env.ANTHROPIC_API_KEY = 'real-key';

      const original = await service.applyEnvVarsToProcess('claude-opus-4.6', 'anthropic-copilot');

      expect(process.env.ANTHROPIC_API_KEY).toBe('');
      expect(original.ANTHROPIC_API_KEY).toBe('real-key');

      service.restoreEnvVars(original);
      expect(process.env.ANTHROPIC_API_KEY).toBe('real-key');
    });

    it('applies stored Anthropic API key as ANTHROPIC_API_KEY', async () => {
      registry.clear();
      registry.register(new AnthropicMockProvider(true, { ANTHROPIC_API_KEY: 'stored-key' }));

      const original = await service.applyEnvVarsToProcess('claude-3-opus', 'anthropic');

      expect(process.env.ANTHROPIC_API_KEY).toBe('stored-key');
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(original.ANTHROPIC_API_KEY).toBeUndefined();

      service.restoreEnvVars(original);
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('applies stored Anthropic OAuth token as CLAUDE_CODE_OAUTH_TOKEN', async () => {
      registry.clear();
      registry.register(
        new AnthropicMockProvider(true, { CLAUDE_CODE_OAUTH_TOKEN: 'stored-oauth-token' })
      );

      const original = await service.applyEnvVarsToProcess('claude-3-opus', 'anthropic');

      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('stored-oauth-token');
      expect(original.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

      service.restoreEnvVars(original);
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('clears provider-leaked official Kimi env vars before Anthropic query', async () => {
      process.env.ANTHROPIC_MODEL = 'kimi-k2.7-code';
      process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'kimi-k2.7-code';
      process.env.ENABLE_TOOL_SEARCH = 'false';
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '262144';

      const original = await service.applyEnvVarsToProcess('claude-3-opus', 'anthropic');

      expect(process.env.ANTHROPIC_MODEL).toBeUndefined();
      expect(process.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
      expect(process.env.ENABLE_TOOL_SEARCH).toBeUndefined();
      expect(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
      expect(original.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
      expect(original.CLAUDE_CODE_SUBAGENT_MODEL).toBe('kimi-k2.7-code');
      expect(original.ENABLE_TOOL_SEARCH).toBe('false');
      expect(original.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('262144');

      service.restoreEnvVars(original);
      expect(process.env.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
      expect(process.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('kimi-k2.7-code');
      expect(process.env.ENABLE_TOOL_SEARCH).toBe('false');
      expect(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('262144');
    });

    it('clears stale Kimi model env before a provider that does not set ANTHROPIC_MODEL', async () => {
      process.env.ANTHROPIC_MODEL = 'kimi-k2.7-code';

      const original = await service.applyEnvVarsToProcess('glm-4', 'glm');

      expect(process.env.ANTHROPIC_MODEL).toBeUndefined();
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.glm.example.com');
      expect(original.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');

      service.restoreEnvVars(original);
      expect(process.env.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
    });

    it('should clear provider-leaked GLM base URL after GLM query', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.glm.example.com';

      const originalFromGlm = await service.applyEnvVarsToProcess('glm-4', 'glm');
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.glm.example.com');

      service.restoreEnvVars(originalFromGlm);

      const originalFromAnthropic = await service.applyEnvVarsToProcess(
        'claude-3-opus',
        'anthropic'
      );

      expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    });

    it('clears PORT from process.env for Anthropic model and restores it afterward', async () => {
      process.env.PORT = '9283';

      const original = await service.applyEnvVarsToProcess('claude-3-opus', 'anthropic');

      expect(process.env.PORT).toBeUndefined();
      expect(original.PORT).toBe('9283');

      service.restoreEnvVars(original);
      expect(process.env.PORT).toBe('9283');
    });

    it('clears HYPERNEO_PORT from process.env for Anthropic model and restores it afterward', async () => {
      process.env.HYPERNEO_PORT = '9983';

      const original = await service.applyEnvVarsToProcess('claude-3-opus', 'anthropic');

      expect(process.env.HYPERNEO_PORT).toBeUndefined();
      expect(original.HYPERNEO_PORT).toBe('9983');

      service.restoreEnvVars(original);
      expect(process.env.HYPERNEO_PORT).toBe('9983');
    });

    it('clears PORT and HYPERNEO_PORT from process.env for GLM model and restores them', async () => {
      process.env.PORT = '8399';
      process.env.HYPERNEO_PORT = '9983';

      const original = await service.applyEnvVarsToProcess('glm-4', 'glm');

      expect(process.env.PORT).toBeUndefined();
      expect(process.env.HYPERNEO_PORT).toBeUndefined();
      expect(original.PORT).toBe('8399');
      expect(original.HYPERNEO_PORT).toBe('9983');

      service.restoreEnvVars(original);
      expect(process.env.PORT).toBe('8399');
      expect(process.env.HYPERNEO_PORT).toBe('9983');
    });
  });

  describe('applyEnvVarsToProcessForProvider', () => {
    it('should clear leaked GLM routing vars for anthropic provider', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.glm.example.com';
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-4';

      const original = await service.applyEnvVarsToProcessForProvider('anthropic');

      expect(original.ANTHROPIC_BASE_URL).toBe('https://api.glm.example.com');
      expect(original.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-4');
      expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    });

    it('should clear leaked routing vars even when stored Anthropic credentials are present', async () => {
      registry.unregister('anthropic');
      registry.register(new AnthropicMockProvider(true, { ANTHROPIC_API_KEY: 'stored-key' }));
      process.env.ANTHROPIC_BASE_URL = 'https://api.glm.example.com';
      process.env.ANTHROPIC_AUTH_TOKEN = 'stale-glm-token';

      const original = await service.applyEnvVarsToProcessForProvider('anthropic');

      expect(original.ANTHROPIC_BASE_URL).toBe('https://api.glm.example.com');
      expect(original.ANTHROPIC_AUTH_TOKEN).toBe('stale-glm-token');
      expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(process.env.ANTHROPIC_API_KEY).toBe('stored-key');
    });

    it('should apply GLM env vars for GLM provider', async () => {
      const original = await service.applyEnvVarsToProcessForProvider('glm', 'glm-4');

      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.glm.example.com');
      expect(original).toBeDefined();
    });

    it('should return {} without throwing when buildSdkConfig throws (e.g. server not yet started)', async () => {
      registry.register(new ThrowingMockProvider());

      const original = await service.applyEnvVarsToProcessForProvider(
        'throwing' as unknown as ProviderId
      );
      expect(original).toEqual({});
    });
  });

  describe('restoreEnvVars', () => {
    it('should restore original env vars', async () => {
      process.env.ANTHROPIC_AUTH_TOKEN = 'original-token';
      process.env.ANTHROPIC_BASE_URL = 'original-url';

      const original = await service.applyEnvVarsToProcess('glm-4', 'glm');

      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.glm.example.com');

      service.restoreEnvVars(original);

      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('original-token');
      expect(process.env.ANTHROPIC_BASE_URL).toBe('original-url');
    });

    it('should delete env vars that were not originally set', async () => {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.ANTHROPIC_BASE_URL;

      const original = await service.applyEnvVarsToProcess('glm-4', 'glm');

      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.glm.example.com');

      service.restoreEnvVars(original);

      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    });

    it('should do nothing for empty original object', async () => {
      process.env.ANTHROPIC_AUTH_TOKEN = 'some-token';

      service.restoreEnvVars({});

      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('some-token');
    });

    it('should only restore keys captured in original', async () => {
      process.env.ANTHROPIC_AUTH_TOKEN = 'keep-me';
      process.env.ANTHROPIC_BASE_URL = 'to-be-restored';

      service.restoreEnvVars({ ANTHROPIC_BASE_URL: 'restored-url' });

      expect(process.env.ANTHROPIC_BASE_URL).toBe('restored-url');
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('keep-me');
    });

    it('should restore all supported env vars', async () => {
      process.env.ANTHROPIC_AUTH_TOKEN = 'auth-token';
      process.env.ANTHROPIC_BASE_URL = 'base-url';
      process.env.API_TIMEOUT_MS = '30000';
      process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '0';
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'sonnet-model';
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'haiku-model';
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'opus-model';

      const original = await service.applyEnvVarsToProcess('glm-4', 'glm');

      service.restoreEnvVars(original);

      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('auth-token');
      expect(process.env.ANTHROPIC_BASE_URL).toBe('base-url');
      expect(process.env.API_TIMEOUT_MS).toBe('30000');
      expect(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('0');
      expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('sonnet-model');
      expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('haiku-model');
      expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('opus-model');
    });
  });

  describe('isGlmAvailable', () => {
    it('should return true when GLM provider is available', async () => {
      const available = await service.isGlmAvailable();
      expect(available).toBe(true);
    });

    it('should return false when GLM provider is not available', async () => {
      registry.clear();
      registry.register(new AnthropicMockProvider(true));
      registry.register(new GlmMockProvider(false));

      const available = await service.isGlmAvailable();
      expect(available).toBe(false);
    });
  });
});

describe('getProviderService', () => {
  beforeEach(() => {
    resetProviderServiceInstance();
    resetProviderRegistry();
    resetProviderFactory();
  });

  afterEach(() => {
    resetProviderServiceInstance();
    resetProviderRegistry();
    resetProviderFactory();
  });

  it('should return singleton instance', async () => {
    const service1 = getProviderService();
    const service2 = getProviderService();

    expect(Object.is(service1, service2) || hasSameMethods(service1, service2)).toBe(true);
  });

  it('should return ProviderService instance', async () => {
    const service = getProviderService();
    expect(typeof service.getDefaultProvider).toBe('function');
    expect(typeof service.getProviderApiKey).toBe('function');
    expect(typeof service.isProviderAvailable).toBe('function');
    expect(typeof service.applyEnvVarsToProcessForProvider).toBe('function');
    expect(typeof service.restoreEnvVars).toBe('function');
  });
});

function hasSameMethods(a: object, b: object): boolean {
  const aKeys = Object.getOwnPropertyNames(a).sort();
  const bKeys = Object.getOwnPropertyNames(b).sort();
  return JSON.stringify(aKeys) === JSON.stringify(bKeys);
}

describe('mergeProviderEnvVars', () => {
  it('should spread provider env vars over process.env', async () => {
    const merged = mergeProviderEnvVars({
      OVERRIDE_VAR: 'provider',
      NEW_VAR: 'new',
    });

    expect(merged.OVERRIDE_VAR).toBe('provider');
    expect(merged.NEW_VAR).toBe('new');
  });

  it('should return a new object when provider env vars is empty', async () => {
    const merged = mergeProviderEnvVars({});
    expect(merged).not.toBe(process.env);
  });
});

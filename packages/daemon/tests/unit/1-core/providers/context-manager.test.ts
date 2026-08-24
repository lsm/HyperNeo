import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ProviderId } from '@hyperneo/shared/provider';
import type { Session, ModelInfo } from '@hyperneo/shared';
import type { Provider, ProviderSdkConfig } from '@hyperneo/shared/provider';
import { ProviderContextManager } from '../../../../src/lib/providers/context-manager';
import { ProviderRegistry, resetProviderRegistry } from '../../../../src/lib/providers/registry';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';
import { AnthropicToCodexBridgeProvider } from '../../../../src/lib/providers/anthropic-to-codex-bridge-provider';
import { AnthropicToCopilotBridgeProvider } from '../../../../src/lib/providers/anthropic-copilot/index';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

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
  }

  isAvailable(): boolean {
    return this.available;
  }

  async getModels(): Promise<ModelInfo[]> {
    return [
      {
        id: `${this.modelPrefix}model-1`,
        name: 'Mock Model 1',
        alias: 'mock1',
        family: 'mock',
        provider: this.id,
        contextWindow: 100000,
        description: 'Mock model',
        releaseDate: '',
        available: true,
      },
    ];
  }

  ownsModel(modelId: string): boolean {
    return modelId.toLowerCase().startsWith(this.modelPrefix);
  }

  getModelForTier(tier: string): string | undefined {
    return `${this.modelPrefix}${tier}`;
  }

  buildSdkConfig(
    modelId: string,
    sessionConfig?: { apiKey?: string; baseUrl?: string; region?: unknown }
  ): ProviderSdkConfig {
    const envVars: Record<string, string> = {
      ANTHROPIC_BASE_URL: sessionConfig?.baseUrl || 'https://mock.api.com',
      ANTHROPIC_AUTH_TOKEN: sessionConfig?.apiKey || 'mock-api-key',
    };
    if (sessionConfig?.region) {
      envVars.REGION = String(sessionConfig.region);
    }
    if (modelId === 'provider-model') {
      envVars.ANTHROPIC_MODEL = 'provider-env-model';
    }
    return {
      envVars,
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  translateModelIdForSdk(modelId: string): string {
    return `sdk-${modelId}`;
  }
}

class AnthropicMockProvider extends MockProvider {
  readonly id = 'anthropic' as const;
  readonly displayName = 'Anthropic';

  constructor(available: boolean = true) {
    super('anthropic', 'Anthropic', available, 'claude-');
  }

  ownsModel(modelId: string): boolean {
    return (
      modelId.toLowerCase().startsWith('claude-') ||
      ['default', 'sonnet', 'haiku', 'opus'].includes(modelId.toLowerCase())
    );
  }

  buildSdkConfig(
    modelId: string,
    sessionConfig?: { apiKey?: string; baseUrl?: string }
  ): ProviderSdkConfig {
    const envVars: Record<string, string> = {};
    if (sessionConfig?.apiKey) {
      envVars.ANTHROPIC_AUTH_TOKEN = sessionConfig.apiKey;
    }
    if (sessionConfig?.baseUrl) {
      envVars.ANTHROPIC_BASE_URL = sessionConfig.baseUrl;
    }
    return {
      envVars,
      isAnthropicCompatible: true,
    };
  }

  translateModelIdForSdk = undefined;
}

class AnthropicCopilotMockProvider extends MockProvider {
  readonly id = 'anthropic-copilot' as const;
  readonly displayName = 'Anthropic Copilot';

  constructor(available: boolean = true) {
    super('anthropic-copilot', 'Anthropic Copilot', available, 'claude-');
  }

  ownsModel(modelId: string): boolean {
    return modelId.toLowerCase().startsWith('claude-');
  }

  buildSdkConfig(
    _modelId: string,
    sessionConfig?: { apiKey?: string; baseUrl?: string }
  ): ProviderSdkConfig {
    return {
      envVars: {
        ANTHROPIC_BASE_URL: sessionConfig?.baseUrl || 'https://copilot.api.com',
        ANTHROPIC_AUTH_TOKEN: sessionConfig?.apiKey || 'copilot-token',
      },
      isAnthropicCompatible: true,
    };
  }
}

class AnthropicCodexMockProvider extends MockProvider {
  readonly id = 'anthropic-codex' as const;
  readonly displayName = 'Anthropic Codex';

  constructor(available: boolean = true) {
    super('anthropic-codex', 'Anthropic Codex', available, 'gpt-');
  }

  ownsModel(modelId: string): boolean {
    return modelId.toLowerCase().startsWith('gpt-') || modelId.toLowerCase().startsWith('claude-');
  }

  buildSdkConfig(
    _modelId: string,
    sessionConfig?: { apiKey?: string; baseUrl?: string }
  ): ProviderSdkConfig {
    return {
      envVars: {
        ANTHROPIC_BASE_URL: sessionConfig?.baseUrl || 'https://codex.api.com',
        ANTHROPIC_AUTH_TOKEN: sessionConfig?.apiKey || 'codex-token',
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

  translateModelIdForSdk(modelId: string): string {
    return modelId.replace('glm-', 'claude-');
  }
}

describe('ProviderContextManager', () => {
  let manager: ProviderContextManager;
  let registry: ProviderRegistry;

  beforeEach(() => {
    resetProviderRegistry();
    resetProviderFactory();

    registry = new ProviderRegistry();
    registry.register(new AnthropicMockProvider(true));
    registry.register(new GlmMockProvider(true));

    manager = new ProviderContextManager(registry);
  });

  afterEach(() => {
    resetProviderRegistry();
    resetProviderFactory();
  });

  describe('createContext', () => {
    it('should create context for session with explicit provider', () => {
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

      const context = manager.createContext(session);

      expect(context.provider.id).toBe('glm');
      expect(context.modelId).toBe('glm-4');
    });

    it('should create context for anthropic session with explicit provider', () => {
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

      const context = manager.createContext(session);

      expect(context.provider.id).toBe('anthropic');
    });

    it('should use "default" model ID when model not specified', () => {
      const session: Session = {
        id: 'test-session',
        title: 'Test',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'anthropic',
        } as Session['config'],
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
        },
      };

      const context = manager.createContext(session);

      expect(context.modelId).toBe('default');
    });

    it('should throw when the stored provider ID is not registered', () => {
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
          provider: 'nonexistent' as unknown as ProviderId,
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

      expect(() => manager.createContext(session)).toThrow(
        "Provider 'nonexistent' (requested by session 'test-session') is not registered."
      );
    });

    it('should fall back to Anthropic when no provider is stored (legacy pre-#466 session)', () => {
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

      const context = manager.createContext(session);
      expect(context.provider.id).toBe('anthropic');
    });

    it('should include session provider config', () => {
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
            apiKey: 'custom-key',
            baseUrl: 'https://custom.api.com',
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

      const context = manager.createContext(session);

      expect(context.sessionConfig).toEqual({
        apiKey: 'custom-key',
        baseUrl: 'https://custom.api.com',
        sessionId: 'test-session',
        workspacePath: '/test',
      });
    });

    it('should include provider region in session config', () => {
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
            apiKey: 'custom-key',
            baseUrl: 'https://custom.api.com',
            region: 'global',
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

      const context = manager.createContext(session);

      expect(context.sessionConfig).toEqual({
        apiKey: 'custom-key',
        baseUrl: 'https://custom.api.com',
        region: 'global',
        sessionId: 'test-session',
        workspacePath: '/test',
      });
      expect(context.sdkConfig.envVars.REGION).toBe('global');
    });
  });

  describe('context getSdkModelId', () => {
    it('should translate model ID for providers that support it', () => {
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

      const context = manager.createContext(session);
      const sdkModelId = context.getSdkModelId();

      expect(sdkModelId).toBe('claude-4');
    });

    it('should return original model ID for anthropic', () => {
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

      const context = manager.createContext(session);
      const sdkModelId = context.getSdkModelId();

      expect(sdkModelId).toBe('claude-3-opus');
    });

    it('should prefer provider ANTHROPIC_MODEL over translated model ID', () => {
      registry.register(new MockProvider('mock', 'Provider Model', true, 'provider-'));
      const session: Session = {
        id: 'test-session',
        title: 'Test',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'provider-model',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'mock' as ProviderId,
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

      const context = manager.createContext(session);

      expect(context.getSdkModelId()).toBe('provider-env-model');
    });
  });

  describe('context buildSdkOptions', () => {
    it('should merge provider env vars with base options', async () => {
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

      const context = manager.createContext(session);
      const options = await context.buildSdkOptions({
        maxTokens: 4096,
        env: { CUSTOM_VAR: 'value' },
      });

      expect(options.model).toBe('claude-4');
      expect(options.maxTokens).toBe(4096);
      expect(options.env).toEqual(
        expect.objectContaining({
          CUSTOM_VAR: 'value',
          ANTHROPIC_BASE_URL: 'https://mock.api.com',
        })
      );
    });

    it('should override model with SDK model ID', async () => {
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

      const context = manager.createContext(session);
      const options = await context.buildSdkOptions({
        model: 'original-model',
      });

      expect(options.model).toBe('claude-4');
    });

    it('should not include env if empty', async () => {
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

      const context = manager.createContext(session);
      const options = await context.buildSdkOptions({
        maxTokens: 4096,
      });

      expect(options.env).toBeUndefined();
    });
  });

  describe('requiresQueryRestart', () => {
    const anthropicSession: Session = {
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

    it('should return true for cross-provider switch', () => {
      const requires = manager.requiresQueryRestart(anthropicSession, 'glm-4', 'glm');
      expect(requires).toBe(true);
    });

    it('should return false for same-provider switch', () => {
      const requires = manager.requiresQueryRestart(
        anthropicSession,
        'claude-3-sonnet',
        'anthropic'
      );
      expect(requires).toBe(false);
    });

    it('should return true when the new provider is not registered', () => {
      const requires = manager.requiresQueryRestart(
        anthropicSession,
        'unknown-model-xyz',
        'unknown-provider-xyz'
      );
      expect(requires).toBe(true);
    });
  });

  describe('getProvider', () => {
    it('should return provider by ID', () => {
      const provider = manager.getProvider('anthropic');
      expect(provider).toBeDefined();
      expect(provider?.id).toBe('anthropic');
    });

    it('should return undefined for unknown provider', () => {
      const provider = manager.getProvider('unknown' as unknown as ProviderId);
      expect(provider).toBeUndefined();
    });
  });

  describe('validateProviderSwitch', () => {
    it('should validate available provider', async () => {
      const result = await manager.validateProviderSwitch('anthropic');
      expect(result.valid).toBe(true);
    });

    it('should reject unavailable provider', async () => {
      registry.clear();
      registry.register(new GlmMockProvider(false));

      const result = await manager.validateProviderSwitch('glm');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not available');
    });

    it('should accept unavailable provider with API key', async () => {
      registry.clear();
      registry.register(new GlmMockProvider(false));

      const result = await manager.validateProviderSwitch('glm', 'test-key');
      expect(result.valid).toBe(true);
    });

    it('should reject unknown provider', async () => {
      const result = await manager.validateProviderSwitch('unknown' as unknown as ProviderId);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unknown provider');
    });
  });

  describe('createContext — anthropic-copilot provider', () => {
    beforeEach(() => {
      resetProviderRegistry();
      resetProviderFactory();
      registry = new ProviderRegistry();
      registry.register(new AnthropicMockProvider(true));
      registry.register(new AnthropicCopilotMockProvider(true));
      manager = new ProviderContextManager(registry);
    });

    it('should create context for session with explicit anthropic-copilot provider', () => {
      const session: Session = {
        id: 'copilot-session',
        title: 'Copilot Session',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4.6',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'anthropic-copilot',
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

      const context = manager.createContext(session);

      expect(context.provider.id).toBe('anthropic-copilot');
      expect(context.modelId).toBe('claude-sonnet-4.6');
    });

    it('should select anthropic-copilot over anthropic when provider explicitly set', () => {
      const copilotSession: Session = {
        id: 'test',
        title: 'Test',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-opus-4.6',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'anthropic-copilot',
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
      const anthropicSession: Session = {
        ...copilotSession,
        config: { ...copilotSession.config, provider: 'anthropic' },
      };

      expect(manager.createContext(copilotSession).provider.id).toBe('anthropic-copilot');
      expect(manager.createContext(anthropicSession).provider.id).toBe('anthropic');
    });

    it('should build sdk options with copilot env vars', async () => {
      const session: Session = {
        id: 'copilot-sdk',
        title: 'Test',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4.6',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'anthropic-copilot',
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

      const context = manager.createContext(session);
      const options = await context.buildSdkOptions({ maxTokens: 4096 });

      expect(options.env).toBeDefined();
      expect(options.env?.ANTHROPIC_BASE_URL).toBe('https://copilot.api.com');
      expect(options.env?.ANTHROPIC_AUTH_TOKEN).toBe('copilot-token');
    });

    it('should return false for requiresQueryRestart within anthropic-copilot', () => {
      const session: Session = {
        id: 'test',
        title: 'Test',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4.6',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'anthropic-copilot',
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

      expect(manager.requiresQueryRestart(session, 'claude-opus-4.6', 'anthropic-copilot')).toBe(
        false
      );
    });

    it('should return true for requiresQueryRestart when switching from copilot to anthropic', () => {
      const session: Session = {
        id: 'test',
        title: 'Test',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4.6',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'anthropic-copilot',
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

      expect(manager.requiresQueryRestart(session, 'claude-opus-4.6', 'anthropic')).toBe(true);
    });
  });

  describe('createContext — anthropic-codex provider', () => {
    beforeEach(() => {
      resetProviderRegistry();
      resetProviderFactory();
      registry = new ProviderRegistry();
      registry.register(new AnthropicMockProvider(true));
      registry.register(new AnthropicCodexMockProvider(true));
      manager = new ProviderContextManager(registry);
    });

    it('should create context for session with explicit anthropic-codex provider', () => {
      const session: Session = {
        id: 'codex-session',
        title: 'Codex Session',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'gpt-5.3-codex',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'anthropic-codex',
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

      const context = manager.createContext(session);

      expect(context.provider.id).toBe('anthropic-codex');
      expect(context.modelId).toBe('gpt-5.3-codex');
    });

    it('should select anthropic-codex over anthropic for claude- models when explicitly set', () => {
      const session: Session = {
        id: 'test',
        title: 'Test',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-opus-4.6',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'anthropic-codex',
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

      expect(manager.createContext(session).provider.id).toBe('anthropic-codex');
    });

    it('should build sdk options with codex env vars', async () => {
      const session: Session = {
        id: 'codex-sdk',
        title: 'Test',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'gpt-5.3-codex',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'anthropic-codex',
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

      const context = manager.createContext(session);
      const options = await context.buildSdkOptions({ maxTokens: 4096 });

      expect(options.env?.ANTHROPIC_BASE_URL).toBe('https://codex.api.com');
      expect(options.env?.ANTHROPIC_AUTH_TOKEN).toBe('codex-token');
    });

    it('should return true for requiresQueryRestart when switching from codex to anthropic', () => {
      const session: Session = {
        id: 'test',
        title: 'Test',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'gpt-5.3-codex',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'anthropic-codex',
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

      expect(manager.requiresQueryRestart(session, 'claude-opus-4.6', 'anthropic')).toBe(true);
    });

    it('should return false for requiresQueryRestart within anthropic-codex', () => {
      const session: Session = {
        id: 'test',
        title: 'Test',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'gpt-5.3-codex',
          maxTokens: 8192,
          temperature: 1.0,
          provider: 'anthropic-codex',
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

      expect(manager.requiresQueryRestart(session, 'gpt-5.6-luna', 'anthropic-codex')).toBe(false);
    });
  });

  describe('getAvailableProviders', () => {
    it('should return available providers', async () => {
      const providers = await manager.getAvailableProviders();

      expect(providers.length).toBe(2);
      expect(providers.map((p) => p.id)).toContain('anthropic');
      expect(providers.map((p) => p.id)).toContain('glm');
    });

    it('should filter unavailable providers', async () => {
      registry.clear();
      registry.register(new AnthropicMockProvider(true));
      registry.register(new GlmMockProvider(false));

      const providers = await manager.getAvailableProviders();

      expect(providers.length).toBe(1);
      expect(providers[0].id).toBe('anthropic');
    });
  });
});

describe('sdk-model-id-aliasing invariant — real provider buildSdkConfig()', () => {
  let codexProvider: AnthropicToCodexBridgeProvider | undefined;

  afterEach(() => {
    codexProvider?.stopAllBridgeServers();
    codexProvider = undefined;
  });

  it.skipIf(!isBun)(
    'Codex provider: ANTHROPIC_DEFAULT_HAIKU_MODEL uses real Codex Luna model ID',
    () => {
      codexProvider = new AnthropicToCodexBridgeProvider({ OPENAI_API_KEY: 'sk-test' });
      const cfg = codexProvider.buildSdkConfig('gpt-5.6-terra', {
        workspacePath: '/tmp/ws-codex-leak',
      });
      expect(cfg.envVars['ANTHROPIC_DEFAULT_HAIKU_MODEL']).toBe('gpt-5.6-luna');
    }
  );

  it.skipIf(!isBun)(
    'Codex provider: all three DEFAULT_*_MODEL slots use real Codex model IDs',
    () => {
      codexProvider = new AnthropicToCodexBridgeProvider({ OPENAI_API_KEY: 'sk-test' });
      const cfg = codexProvider.buildSdkConfig('gpt-5.6-terra', {
        workspacePath: '/tmp/ws-codex-all',
      });
      expect(cfg.envVars['ANTHROPIC_DEFAULT_HAIKU_MODEL']).toBe('gpt-5.6-luna');
      expect(cfg.envVars['ANTHROPIC_DEFAULT_SONNET_MODEL']).toBe('gpt-5.6-terra');
      expect(cfg.envVars['ANTHROPIC_DEFAULT_OPUS_MODEL']).toBe('gpt-5.6-sol');
    }
  );

  it('Copilot provider: all three DEFAULT_*_MODEL slots are set to the resolved model ID', () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'tok' });
    (p as unknown as Record<string, unknown>)['serverCache'] = {
      url: 'http://127.0.0.1:54321',
      stop: async () => {},
    };
    const internals = p as unknown as Record<string, number>;
    internals['clientCredentialsVersion'] = internals['credentialsVersion'];
    const cfg = p.buildSdkConfig('copilot-anthropic-sonnet');
    expect(cfg.envVars['ANTHROPIC_DEFAULT_HAIKU_MODEL']).toBe(
      cfg.envVars['ANTHROPIC_DEFAULT_SONNET_MODEL']
    );
    expect(cfg.envVars['ANTHROPIC_DEFAULT_OPUS_MODEL']).toBe(
      cfg.envVars['ANTHROPIC_DEFAULT_SONNET_MODEL']
    );
    expect(cfg.envVars['ANTHROPIC_DEFAULT_HAIKU_MODEL']).not.toBe('claude-haiku-4-5-20251001');
  });
});

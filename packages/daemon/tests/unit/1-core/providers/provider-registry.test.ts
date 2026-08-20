import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { ModelInfo } from '@hyperneo/shared';
import { Logger } from '@hyperneo/shared/logger';
import type { Provider, ProviderSdkConfig } from '@hyperneo/shared/provider';
import {
  initializeProviders,
  resetProviderFactory,
  waitForOptionalProviderRegistration,
} from '../../../../src/lib/providers/factory';
import {
  ProviderRegistry,
  getProviderRegistry,
  inferPersistableProviderForModel,
  inferProviderForModel,
  resetProviderRegistry,
} from '../../../../src/lib/providers/registry';

class MockProvider implements Provider {
  readonly id = 'mock';
  readonly displayName = 'Mock Provider';
  readonly capabilities = {
    streaming: true,
    extendedThinking: false,
    maxContextWindow: 100000,
    functionCalling: true,
    vision: false,
  };

  constructor(
    private available: boolean = true,
    private modelPrefix: string = 'mock-'
  ) {}

  isAvailable(): boolean {
    return this.available;
  }

  async getModels(): Promise<ModelInfo[]> {
    return [
      {
        id: 'mock-1',
        name: 'Mock Model 1',
        alias: 'mock1',
        family: 'mock',
        provider: 'mock',
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

  getModelForTier(): string | undefined {
    return 'mock-1';
  }

  buildSdkConfig(): ProviderSdkConfig {
    return {
      envVars: {},
      isAnthropicCompatible: true,
    };
  }
}

function makeAnthropicProvider() {
  return new (class extends MockProvider {
    readonly id = 'anthropic' as const;
    readonly displayName = 'Anthropic';
    ownsModel(modelId: string): boolean {
      return modelId.startsWith('claude-');
    }
  })();
}

function makeAnthropicCopilotProvider() {
  return new (class extends MockProvider {
    readonly id = 'anthropic-copilot' as const;
    readonly displayName = 'Anthropic Copilot';
    ownsModel(modelId: string): boolean {
      return modelId.startsWith('claude-');
    }
  })();
}

function makeAnthropicCodexProvider() {
  return new (class extends MockProvider {
    readonly id = 'anthropic-codex' as const;
    readonly displayName = 'Anthropic Codex';
    ownsModel(modelId: string): boolean {
      return modelId.startsWith('gpt-') || modelId.startsWith('claude-');
    }
  })();
}

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    resetProviderRegistry();
    resetProviderFactory();
    registry = new ProviderRegistry();
  });

  afterEach(() => {
    resetProviderRegistry();
    resetProviderFactory();
  });

  describe('register', () => {
    it('should register a provider', () => {
      const provider = new MockProvider();
      registry.register(provider);

      expect(registry.size).toBe(1);
      expect(registry.get('mock')).toBe(provider);
    });

    it('should throw when registering duplicate provider ID', () => {
      const provider = new MockProvider();
      registry.register(provider);

      expect(() => registry.register(new MockProvider())).toThrow(
        'Provider mock is already registered'
      );
    });
  });

  describe('unregister', () => {
    it('should unregister a provider', () => {
      const provider = new MockProvider();
      registry.register(provider);
      expect(registry.size).toBe(1);

      registry.unregister('mock');
      expect(registry.size).toBe(0);
      expect(registry.get('mock')).toBeUndefined();
    });

    it('should handle unregistering non-existent provider', () => {
      expect(() => registry.unregister('nonexistent')).not.toThrow();
    });
  });

  describe('get', () => {
    it('should get a registered provider', () => {
      const provider = new MockProvider();
      registry.register(provider);

      expect(registry.get('mock')).toBe(provider);
    });

    it('should return undefined for non-existent provider', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });

  describe('has', () => {
    it('should return true for registered provider', () => {
      const provider = new MockProvider();
      registry.register(provider);

      expect(registry.has('mock')).toBe(true);
    });

    it('should return false for non-existent provider', () => {
      expect(registry.has('nonexistent')).toBe(false);
    });
  });

  describe('getAll', () => {
    it('should return all registered providers', () => {
      const mock1 = new MockProvider();

      const mock2 = new (class extends MockProvider {
        readonly id = 'mock2' as const;
        readonly displayName = 'Mock Provider 2';
      })();

      registry.register(mock1);
      registry.register(mock2);

      const all = registry.getAll();
      expect(all).toHaveLength(2);
      expect(all.map((p) => p.id)).toEqual(['mock', 'mock2']);
    });

    it('should return empty array when no providers registered', () => {
      expect(registry.getAll()).toEqual([]);
    });
  });

  describe('getAvailable', () => {
    it('should return only available providers', async () => {
      const availableProvider = new MockProvider(true);

      class UnavailableMock extends MockProvider {
        readonly id = 'unavailable' as const;
        readonly displayName = 'Unavailable';
        constructor() {
          super(false);
        }
      }

      registry.register(availableProvider);
      registry.register(new UnavailableMock());

      const available = await registry.getAvailable();
      expect(available).toHaveLength(1);
      expect(available[0].id).toBe('mock');
    });

    it('should return empty array when no providers available', async () => {
      registry.register(new MockProvider(false));

      const available = await registry.getAvailable();
      expect(available).toEqual([]);
    });
  });

  describe('detectProviderForModel', () => {
    it('should return copilot provider when providerId is anthropic-copilot', () => {
      registry.register(makeAnthropicProvider());
      registry.register(makeAnthropicCopilotProvider());

      const result = registry.detectProviderForModel('claude-opus-4.6', 'anthropic-copilot');
      expect(result?.id).toBe('anthropic-copilot');
    });

    it('should return anthropic provider when providerId is anthropic', () => {
      registry.register(makeAnthropicProvider());
      registry.register(makeAnthropicCopilotProvider());

      const result = registry.detectProviderForModel('claude-opus-4.6', 'anthropic');
      expect(result?.id).toBe('anthropic');
    });

    it('should return codex provider for gpt- model when providerId is anthropic-codex', () => {
      registry.register(makeAnthropicProvider());
      registry.register(makeAnthropicCodexProvider());

      const result = registry.detectProviderForModel('gpt-5.3-codex', 'anthropic-codex');
      expect(result?.id).toBe('anthropic-codex');
    });

    it('should return undefined and log an error when providerId is not registered', () => {
      const errorSpy = spyOn(Logger.prototype, 'error').mockImplementation(mock(() => {}));

      try {
        registry.register(makeAnthropicProvider());

        const result = registry.detectProviderForModel('claude-opus-4.6', 'nonexistent-provider');
        expect(result).toBeUndefined();
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const errArg = errorSpy.mock.calls[0][0] as string;
        expect(errArg).toContain('nonexistent-provider');
        expect(errArg).toContain('claude-opus-4.6');
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe('validateProviderSwitch', () => {
    it('should validate available provider', async () => {
      registry.register(new MockProvider(true));

      const result = await registry.validateProviderSwitch('mock');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject unavailable provider', async () => {
      registry.register(new MockProvider(false));

      const result = await registry.validateProviderSwitch('mock');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not available');
    });

    it('should accept unavailable provider with API key', async () => {
      registry.register(new MockProvider(false));

      const result = await registry.validateProviderSwitch('mock', 'test-key');
      expect(result.valid).toBe(true);
    });

    it('should reject unknown provider', async () => {
      const result = await registry.validateProviderSwitch('unknown');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unknown provider');
    });
  });

  describe('clear', () => {
    it('should clear all providers', () => {
      registry.register(new MockProvider());
      registry.register(
        new (class extends MockProvider {
          readonly id = 'mock2' as const;
        })()
      );

      expect(registry.size).toBe(2);

      registry.clear();
      expect(registry.size).toBe(0);
    });
  });

  describe('initializeProviders — all built-in providers registered', () => {
    it('should register exactly eleven built-in providers', async () => {
      const reg = initializeProviders();
      await waitForOptionalProviderRegistration();

      const ids = reg
        .getAll()
        .map((p) => p.id)
        .sort();
      expect(ids).toEqual(
        [
          'acp',
          'anthropic',
          'anthropic-codex',
          'anthropic-copilot',
          'deepseek',
          'glm',
          'kimi',
          'minimax',
          'ollama',
          'ollama-cloud',
          'openrouter',
        ].sort()
      );
    });

    it('should include anthropic provider', () => {
      const reg = initializeProviders();
      expect(reg.has('anthropic')).toBe(true);
    });

    it('should include glm provider', () => {
      const reg = initializeProviders();
      expect(reg.has('glm')).toBe(true);
    });

    it('should include minimax provider', () => {
      const reg = initializeProviders();
      expect(reg.has('minimax')).toBe(true);
    });

    it('should include kimi provider', () => {
      const reg = initializeProviders();
      expect(reg.has('kimi')).toBe(true);
    });

    it('should include openrouter provider', () => {
      const reg = initializeProviders();
      expect(reg.has('openrouter')).toBe(true);
    });

    it('should include ollama providers', () => {
      const reg = initializeProviders();
      expect(reg.has('ollama')).toBe(true);
      expect(reg.has('ollama-cloud')).toBe(true);
    });

    it('should include anthropic-codex provider', () => {
      const reg = initializeProviders();
      expect(reg.has('anthropic-codex')).toBe(true);
    });

    it('should include anthropic-copilot provider', async () => {
      const reg = initializeProviders();
      await waitForOptionalProviderRegistration();
      expect(reg.has('anthropic-copilot')).toBe(true);
    });

    it('should include acp provider', () => {
      const reg = initializeProviders();
      expect(reg.has('acp')).toBe(true);
      expect(reg.detectProviderForModel('acp-default', 'acp')?.id).toBe('acp');
    });

    it('should infer acp provider from acp model IDs', () => {
      expect(inferProviderForModel('acp')).toBe('acp');
      expect(inferProviderForModel('acp-default')).toBe('acp');
    });

    it('should return the same singleton registry on repeated calls without reset', async () => {
      const reg1 = initializeProviders();
      await waitForOptionalProviderRegistration();
      const reg2 = initializeProviders();
      expect(reg1).toBe(reg2);
      expect(reg2.size).toBe(11);
    });

    it('should use the global registry singleton', async () => {
      initializeProviders();
      await waitForOptionalProviderRegistration();
      const globalReg = getProviderRegistry();
      expect(globalReg.size).toBe(11);
    });

    it('should restore all providers after the registry is reset without factory reset', async () => {
      const reg = initializeProviders();
      await waitForOptionalProviderRegistration();
      expect(reg.has('anthropic-copilot')).toBe(true);

      resetProviderRegistry();
      const resetReg = initializeProviders();
      await waitForOptionalProviderRegistration();

      const ids = resetReg
        .getAll()
        .map((p) => p.id)
        .sort();
      expect(ids).toEqual(
        [
          'acp',
          'anthropic',
          'anthropic-codex',
          'anthropic-copilot',
          'deepseek',
          'glm',
          'kimi',
          'minimax',
          'ollama',
          'ollama-cloud',
          'openrouter',
        ].sort()
      );
    });
  });

  describe('ownsModel collision — anthropic vs anthropic-copilot vs anthropic-codex', () => {
    it('anthropic and anthropic-copilot both claim claude- models', () => {
      const anthropic = makeAnthropicProvider();
      const copilot = makeAnthropicCopilotProvider();

      expect(anthropic.ownsModel('claude-sonnet-4.6')).toBe(true);
      expect(copilot.ownsModel('claude-sonnet-4.6')).toBe(true);
    });

    it('anthropic-codex additionally claims gpt- models', () => {
      const codex = makeAnthropicCodexProvider();

      expect(codex.ownsModel('gpt-5.3-codex')).toBe(true);
      expect(codex.ownsModel('claude-opus-4.6')).toBe(true);
    });

    it('detectProviderForModel is deterministic for colliding model IDs', () => {
      registry.register(makeAnthropicProvider());
      registry.register(makeAnthropicCopilotProvider());
      registry.register(makeAnthropicCodexProvider());

      expect(registry.detectProviderForModel('claude-sonnet-4.6', 'anthropic')?.id).toBe(
        'anthropic'
      );
      expect(registry.detectProviderForModel('claude-sonnet-4.6', 'anthropic-copilot')?.id).toBe(
        'anthropic-copilot'
      );
      expect(registry.detectProviderForModel('claude-opus-4.6', 'anthropic-codex')?.id).toBe(
        'anthropic-codex'
      );
    });

    it('detectProviderForModel returns undefined for unknown provider regardless of model', () => {
      registry.register(makeAnthropicProvider());

      const errorSpy = spyOn(Logger.prototype, 'error').mockImplementation(mock(() => {}));
      try {
        const result = registry.detectProviderForModel('claude-sonnet-4.6', 'unknown-provider');
        expect(result).toBeUndefined();
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe('getDefaultProvider', () => {
    it('should use DEFAULT_PROVIDER env var when set', async () => {
      const original = process.env.DEFAULT_PROVIDER;
      process.env.DEFAULT_PROVIDER = 'mock';

      try {
        registry.register(new MockProvider());

        const provider = await registry.getDefaultProvider();
        expect(provider.id).toBe('mock');
      } finally {
        if (original !== undefined) {
          process.env.DEFAULT_PROVIDER = original;
        } else {
          delete process.env.DEFAULT_PROVIDER;
        }
      }
    });

    it('should use first available provider when no env var', async () => {
      registry.register(new MockProvider(true));

      const provider = await registry.getDefaultProvider();
      expect(provider.id).toBe('mock');
    });

    it('should fall back to first registered when none available', async () => {
      registry.register(new MockProvider(false));

      const provider = await registry.getDefaultProvider();
      expect(provider.id).toBe('mock');
    });

    it('should throw when no providers registered', async () => {
      await expect(registry.getDefaultProvider()).rejects.toThrow('No providers registered');
    });
  });
});

describe('inferProviderForModel', () => {
  it('maps glm- prefix to glm', () => {
    expect(inferProviderForModel('glm-5-turbo')).toBe('glm');
    expect(inferProviderForModel('glm-4')).toBe('glm');
  });

  it('maps bare glm to glm', () => {
    expect(inferProviderForModel('glm')).toBe('glm');
  });

  it('maps minimax- prefix to minimax', () => {
    expect(inferProviderForModel('minimax-m2.5')).toBe('minimax');
  });

  it('maps bare minimax to minimax', () => {
    expect(inferProviderForModel('minimax')).toBe('minimax');
  });

  it('maps Kimi/Moonshot model IDs to kimi', () => {
    expect(inferProviderForModel('moonshot-v1-32k')).toBe('kimi');
    expect(inferProviderForModel('Moonshot-v1-32k')).toBe('kimi');
    expect(inferProviderForModel('kimi-for-coding')).toBe('kimi');
    expect(inferProviderForModel('Kimi')).toBe('kimi');
    expect(inferProviderForModel('kimi')).toBe('kimi');
  });

  it('maps documented [1m] K3 aliases to kimi before anthropic fallback', () => {
    expect(inferProviderForModel('k3[1m]')).toBe('kimi');
    expect(inferProviderForModel('kimi-k3[1m]')).toBe('kimi');
    expect(inferProviderForModel('K3[1M]')).toBe('kimi');
  });

  it('does not hijack Ollama tags with kimi/moonshot prefixes', () => {
    expect(inferProviderForModel('kimi-k2:latest')).not.toBe('kimi');
    expect(inferProviderForModel('moonshot-v1:latest')).not.toBe('kimi');
  });

  it('maps Kimi/Moonshot model IDs before registry fallback providers', () => {
    try {
      getProviderRegistry().register(
        new (class extends MockProvider {
          readonly id = 'anthropic' as const;
          readonly displayName = 'Anthropic';
          ownsModel(): boolean {
            return true;
          }
        })()
      );

      expect(inferProviderForModel('moonshot-v1-32k')).toBe('kimi');
      expect(inferProviderForModel('Moonshot-v1-32k')).toBe('kimi');
      expect(inferProviderForModel('kimi-for-coding')).toBe('kimi');
      expect(inferProviderForModel('Kimi')).toBe('kimi');
    } finally {
      resetProviderRegistry();
    }
  });

  it('maps ACP model IDs before registry fallback providers', () => {
    try {
      getProviderRegistry().register(
        new (class extends MockProvider {
          readonly id = 'anthropic' as const;
          readonly displayName = 'Anthropic';
          ownsModel(): boolean {
            return true;
          }
        })()
      );

      expect(inferProviderForModel('acp')).toBe('acp');
      expect(inferProviderForModel('acp-default')).toBe('acp');
      expect(inferProviderForModel('ACP-custom')).toBe('acp');
    } finally {
      resetProviderRegistry();
    }
  });

  it('maps bare ollama/openrouter shorthands before registry fallback providers', () => {
    try {
      getProviderRegistry().register(
        new (class extends MockProvider {
          readonly id = 'anthropic' as const;
          readonly displayName = 'Anthropic';
          ownsModel(): boolean {
            return true;
          }
        })()
      );

      expect(inferProviderForModel('ollama')).toBe('ollama');
      expect(inferProviderForModel('Ollama')).toBe('ollama');
      expect(inferProviderForModel('ollama-cloud')).toBe('ollama-cloud');
      expect(inferProviderForModel('openrouter/auto')).toBe('openrouter');
      expect(inferProviderForModel('openai/gpt-5.4')).toBe('openrouter');
      expect(inferProviderForModel('anthropic/claude-sonnet-4.6')).toBe('openrouter');
      expect(inferProviderForModel('claude-sonnet-4.6/preview')).toBe('anthropic');
    } finally {
      resetProviderRegistry();
    }
  });

  it('maps bare glm/minimax aliases before registry fallback providers', () => {
    try {
      getProviderRegistry().register(
        new (class extends MockProvider {
          readonly id = 'anthropic' as const;
          readonly displayName = 'Anthropic';
          ownsModel(): boolean {
            return true;
          }
        })()
      );

      expect(inferProviderForModel('glm')).toBe('glm');
      expect(inferProviderForModel('GLM')).toBe('glm');
      expect(inferProviderForModel('minimax')).toBe('minimax');
      expect(inferProviderForModel('MiniMax')).toBe('minimax');
    } finally {
      resetProviderRegistry();
    }
  });

  it('routes bare and dashed glm/minimax IDs with the real registry populated', () => {
    try {
      initializeProviders();

      expect(inferProviderForModel('glm')).toBe('glm');
      expect(inferProviderForModel('glm-4')).toBe('glm');
      expect(inferProviderForModel('glm-5-turbo')).toBe('glm');
      expect(inferProviderForModel('minimax')).toBe('minimax');
      expect(inferProviderForModel('minimax-m2.5')).toBe('minimax');
    } finally {
      resetProviderRegistry();
      resetProviderFactory();
    }
  });

  it('maps OpenRouter provider/model refs to openrouter', () => {
    expect(inferProviderForModel('openrouter/auto')).toBe('openrouter');
    expect(inferProviderForModel('anthropic/claude-sonnet-4.6')).toBe('openrouter');
    expect(inferProviderForModel('openai/gpt-5.4')).toBe('openrouter');
    expect(inferProviderForModel('deepseek/deepseek-r1')).toBe('openrouter');
  });

  it('maps Ollama model shorthands to Ollama providers', () => {
    expect(inferProviderForModel('ollama')).toBe('ollama');
    expect(inferProviderForModel('ollama-cloud')).toBe('ollama-cloud');
    expect(inferProviderForModel('gpt-oss:20b')).toBe('ollama');
    expect(inferProviderForModel('gpt-oss:120b')).toBe('ollama-cloud');
    expect(inferProviderForModel('gpt-oss:120b-cloud')).toBe('ollama-cloud');
    expect(inferProviderForModel('qwen3.5:cloud')).toBe('ollama-cloud');
    expect(inferProviderForModel('qwen3:32b')).toBe('ollama');
    expect(inferProviderForModel('qwen3-coder:480b')).toBe('ollama-cloud');
    expect(inferProviderForModel('other-provider-cloud')).toBe('anthropic');
  });

  it('maps discoverable Codex prefixes to anthropic-codex', () => {
    expect(inferProviderForModel('gpt-5.3-codex')).toBe('anthropic-codex');
    expect(inferProviderForModel('gpt-5.4')).toBe('anthropic-codex');
    expect(inferProviderForModel('o3')).toBe('anthropic-codex');
    expect(inferProviderForModel('o4-mini')).toBe('anthropic-codex');
    expect(inferProviderForModel('codex-mini-latest')).toBe('anthropic-codex');
    expect(inferProviderForModel('ft:o3:team:custom')).toBe('anthropic-codex');
    expect(inferProviderForModel('ft:gpt-5.4:team:custom')).toBe('anthropic-codex');
  });

  it('maps Codex prefixes before catch-all registry providers', () => {
    try {
      getProviderRegistry().register(
        new (class extends MockProvider {
          readonly id = 'anthropic' as const;
          readonly displayName = 'Anthropic';
          ownsModel(): boolean {
            return true;
          }
        })()
      );

      expect(inferProviderForModel('o3')).toBe('anthropic-codex');
      expect(inferProviderForModel('codex-mini-latest')).toBe('anthropic-codex');
      expect(inferProviderForModel('ft:o3:team:custom')).toBe('anthropic-codex');
    } finally {
      resetProviderRegistry();
    }
  });

  it('prefers registered owners over synchronous Codex-style inference', () => {
    try {
      getProviderRegistry().register(
        new (class extends MockProvider {
          readonly id = 'anthropic' as const;
          readonly displayName = 'Anthropic';
          ownsModel(): boolean {
            return true;
          }
        })()
      );
      getProviderRegistry().register(
        new (class extends MockProvider {
          readonly id = 'anthropic-codex' as const;
          readonly displayName = 'Anthropic Codex';
          ownsModel(modelId: string): boolean {
            return modelId === 'gpt-5.3-codex' || modelId.startsWith('o3');
          }
        })()
      );
      getProviderRegistry().register(
        new (class extends MockProvider {
          readonly id = 'anthropic-copilot' as const;
          readonly displayName = 'Anthropic Copilot';
          ownsModel(modelId: string): boolean {
            return (
              modelId === 'gpt-5.3-codex' ||
              modelId === 'gpt-5-mini' ||
              modelId === 'ft:gpt-5-mini:team:custom'
            );
          }
        })()
      );

      expect(inferProviderForModel('gpt-5.3-codex')).toBe('anthropic-codex');
      expect(inferProviderForModel('gpt-5-mini')).toBe('anthropic-copilot');
      expect(inferProviderForModel('ft:gpt-5-mini:team:custom')).toBe('anthropic-copilot');
      expect(inferProviderForModel('o3')).toBe('anthropic-codex');
      expect(inferProviderForModel('ft:o3:team:custom')).toBe('anthropic-codex');
    } finally {
      resetProviderRegistry();
    }
  });

  it('keeps provider-tagged Codex prefixes with Ollama owners', () => {
    try {
      getProviderRegistry().register(
        new (class extends MockProvider {
          readonly id = 'ollama' as const;
          readonly displayName = 'Ollama';
          ownsModel(modelId: string): boolean {
            return modelId.includes(':');
          }
        })()
      );

      expect(inferProviderForModel('o3:latest')).toBe('ollama');
      expect(inferProviderForModel('gpt-4o:latest')).toBe('ollama');
      expect(inferProviderForModel('ft:o3:team:custom')).toBe('anthropic-codex');
    } finally {
      resetProviderRegistry();
    }
  });

  it('defaults claude- models to anthropic', () => {
    expect(inferProviderForModel('claude-opus-4-6')).toBe('anthropic');
    expect(inferProviderForModel('claude-sonnet-4.6/preview')).toBe('anthropic');
  });

  it('defaults unknown models to anthropic', () => {
    expect(inferProviderForModel('sonnet')).toBe('anthropic');
    expect(inferProviderForModel('unknown-model')).toBe('anthropic');
  });

  it('defaults gemini- models to anthropic (no Google provider registered)', () => {
    expect(inferProviderForModel('gemini-2.5-pro')).toBe('anthropic');
    expect(inferProviderForModel('gemini-2.5-flash')).toBe('anthropic');
    expect(inferProviderForModel('gemini-3.1-pro-preview')).toBe('anthropic');
  });
});

describe('inferPersistableProviderForModel', () => {
  it('returns undefined for contested anthropic/codex inferences', async () => {
    expect(await inferPersistableProviderForModel('claude-sonnet-4.6')).toBeUndefined();
    expect(await inferPersistableProviderForModel('gemini-3.1-pro-preview')).toBeUndefined();
    expect(await inferPersistableProviderForModel('unknown-model')).toBeUndefined();
  });

  it('returns positive non-contested identifications as-is', async () => {
    expect(await inferPersistableProviderForModel('kimi-for-coding')).toBe('kimi');
    expect(await inferPersistableProviderForModel('k3[1m]')).toBe('kimi');
    expect(await inferPersistableProviderForModel('glm')).toBe('glm');
    expect(await inferPersistableProviderForModel('glm-4')).toBe('glm');
    expect(await inferPersistableProviderForModel('minimax')).toBe('minimax');
    expect(await inferPersistableProviderForModel('minimax-m2.5')).toBe('minimax');
    expect(await inferPersistableProviderForModel('acp-default')).toBe('acp');
    expect(await inferPersistableProviderForModel('gpt-oss:20b')).toBe('ollama');
    expect(await inferPersistableProviderForModel('openai/gpt-5.4')).toBe('openrouter');
  });

  it('persists the static codex default for gpt-* when no live provider contests it', async () => {
    expect(await inferPersistableProviderForModel('gpt-5.4')).toBe('anthropic-codex');
  });
});

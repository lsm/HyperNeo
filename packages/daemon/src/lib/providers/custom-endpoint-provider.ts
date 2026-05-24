/**
 * Custom Endpoint Provider
 *
 * Wraps a user-defined API endpoint of one of three upstream types:
 *
 *   - `openai-chat`         OpenAI Chat Completions (default for legacy
 *                           configs persisted before the discriminator existed)
 *   - `anthropic-messages`  Anthropic Messages pass-through
 *   - `ollama-native`       Ollama native `/api/chat` (NDJSON streaming)
 *
 * Each instance:
 *
 * 1. Has a deterministic provider ID of the form `custom:<endpointId>` so it
 *    coexists with the built-in providers in the registry.
 * 2. Owns one or more embedded bridge servers, lazily started on first
 *    `buildSdkConfig` call. The bridge selected by `type` translates between
 *    the Anthropic Messages API the SDK speaks and the upstream wire format.
 * 3. Reports model-level capabilities (`toolUse`, `vision`, `thinking`,
 *    `caching`, `maxContextTokens`) so the rest of the system can degrade
 *    gracefully when a feature isn't supported.
 *
 * Tests can pass `bridgeFactories` and `bridgeFetchImpl` to substitute fake
 * bridges or fetch implementations on a per-type basis.
 */

import type {
  ModelTier,
  Provider,
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderSdkConfig,
  ProviderSessionConfig,
} from '@neokai/shared/provider';
import type { ModelInfo } from '@neokai/shared';
import {
  CUSTOM_ENDPOINT_TYPE_CAPABILITY_DEFAULTS,
  DEFAULT_CUSTOM_ENDPOINT_CAPABILITIES,
  resolveCustomEndpointType,
  type CustomEndpointConfig,
  type CustomEndpointModel,
  type CustomEndpointModelCapabilities,
  type CustomEndpointType,
} from '@neokai/shared';
import {
  createOpenAIChatBridgeServer,
  type OpenAIChatBridgeConfig,
  type OpenAIChatBridgeServer,
} from './openai-chat-bridge/server.js';
import {
  createAnthropicMessagesBridgeServer,
  type AnthropicMessagesBridgeConfig,
  type AnthropicMessagesBridgeServer,
} from './anthropic-messages-bridge/server.js';
import {
  createOllamaNativeBridgeServer,
  type OllamaNativeBridgeConfig,
  type OllamaNativeBridgeServer,
} from './ollama-native-bridge/server.js';

/** Prefix prepended to user-supplied endpoint IDs to form a provider ID. */
export const CUSTOM_ENDPOINT_PROVIDER_PREFIX = 'custom:';

export function customProviderIdFor(endpointId: string): string {
  return `${CUSTOM_ENDPOINT_PROVIDER_PREFIX}${endpointId}`;
}

export function isCustomEndpointProviderId(providerId: string): boolean {
  return providerId.startsWith(CUSTOM_ENDPOINT_PROVIDER_PREFIX);
}

/**
 * Common shape every bridge type exposes. Lets the provider hold a
 * heterogeneous map of bridges without leaking the per-type config to
 * higher layers.
 */
interface CustomEndpointBridge {
  port: number;
  stop(): void;
}

export interface CustomEndpointProviderOptions {
  /** Override fetch used by every bridge type (tests). */
  bridgeFetchImpl?: typeof fetch;
  /**
   * Per-type factory overrides for tests. Any type not overridden falls back
   * to the real implementation.
   */
  bridgeFactories?: {
    'openai-chat'?: (config: OpenAIChatBridgeConfig) => OpenAIChatBridgeServer;
    'anthropic-messages'?: (config: AnthropicMessagesBridgeConfig) => AnthropicMessagesBridgeServer;
    'ollama-native'?: (config: OllamaNativeBridgeConfig) => OllamaNativeBridgeServer;
  };
  /**
   * Legacy single-factory override. Equivalent to passing the factory under
   * `bridgeFactories['openai-chat']`. Retained so existing tests don't need
   * to be rewritten just to keep working with the OpenAI Chat default type.
   */
  bridgeFactory?: (config: OpenAIChatBridgeConfig) => OpenAIChatBridgeServer;
}

/** Resolve model-level capabilities with type-specific then global defaults applied. */
export function resolveModelCapabilities(
  model: CustomEndpointModel,
  type: CustomEndpointType = 'openai-chat'
): CustomEndpointModelCapabilities {
  return {
    ...DEFAULT_CUSTOM_ENDPOINT_CAPABILITIES,
    ...CUSTOM_ENDPOINT_TYPE_CAPABILITY_DEFAULTS[type],
    ...model.capabilities,
  };
}

function modelDisplayName(model: CustomEndpointModel): string {
  return model.name ?? model.id;
}

function providerModelStringFor(model: CustomEndpointModel): string {
  return model.providerModelId ?? model.id;
}

export class CustomEndpointProvider implements Provider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  private readonly config: CustomEndpointConfig;
  private readonly type: CustomEndpointType;
  private readonly options: CustomEndpointProviderOptions;
  private bridges = new Map<string, CustomEndpointBridge>();

  constructor(config: CustomEndpointConfig, options: CustomEndpointProviderOptions = {}) {
    if (!config.id) throw new Error('CustomEndpointProvider: endpoint id is required');
    if (!config.baseUrl)
      throw new Error(`CustomEndpointProvider[${config.id}]: baseUrl is required`);
    if (!config.models || config.models.length === 0)
      throw new Error(`CustomEndpointProvider[${config.id}]: at least one model is required`);
    this.config = config;
    this.type = resolveCustomEndpointType(config);
    this.options = options;
    this.id = customProviderIdFor(config.id);
    this.displayName = config.name || config.id;
    this.capabilities = this.aggregateCapabilities(config.models);
  }

  /**
   * Aggregate provider-level capabilities by taking the most-permissive value
   * across all configured models. Per-request gating still uses each model's
   * own capability map so unsupported features are dropped before they hit
   * the upstream.
   */
  private aggregateCapabilities(models: CustomEndpointModel[]): ProviderCapabilities {
    let streaming = false;
    let extendedThinking = false;
    let functionCalling = false;
    let vision = false;
    let maxContextWindow = 0;
    for (const model of models) {
      const caps = resolveModelCapabilities(model, this.type);
      streaming = streaming || caps.streaming;
      extendedThinking = extendedThinking || caps.thinking;
      functionCalling = functionCalling || caps.toolUse;
      vision = vision || caps.vision;
      if (caps.maxContextTokens > maxContextWindow) maxContextWindow = caps.maxContextTokens;
    }
    return {
      streaming,
      extendedThinking,
      thinkingModes: extendedThinking ? 'on' : 'off',
      maxContextWindow: maxContextWindow || DEFAULT_CUSTOM_ENDPOINT_CAPABILITIES.maxContextTokens,
      functionCalling,
      vision,
    };
  }

  async isAvailable(): Promise<boolean> {
    // Local endpoints (no API key) are available if baseUrl is set; for
    // remote endpoints with an API key we still report true and let the
    // upstream surface auth errors on first request. We avoid a probe here
    // to keep startup fast and to support endpoints that don't expose a
    // reachable health check.
    return Boolean(this.config.baseUrl);
  }

  async getModels(): Promise<ModelInfo[]> {
    return this.config.models.map((model) => this.toModelInfo(model));
  }

  ownsModel(modelId: string): boolean {
    return this.config.models.some((m) => m.id === modelId);
  }

  getModelForTier(_tier: ModelTier): string | undefined {
    if (this.config.defaultModelId) {
      const match = this.config.models.find((m) => m.id === this.config.defaultModelId);
      if (match) return match.id;
    }
    return this.config.models[0]?.id;
  }

  buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    const model =
      this.config.models.find((m) => m.id === modelId) ??
      this.config.models.find((m) => m.id === this.config.defaultModelId) ??
      this.config.models[0];
    if (!model) {
      throw new Error(
        `Custom endpoint '${this.config.id}' has no models; cannot build SDK config for '${modelId}'`
      );
    }
    const caps = resolveModelCapabilities(model, this.type);
    const baseUrl = sessionConfig?.baseUrl || this.config.baseUrl;
    const apiKey = sessionConfig?.apiKey ?? this.config.apiKey;
    const bridge = this.getOrCreateBridge({ baseUrl, apiKey, caps, model });
    const upstreamModel = providerModelStringFor(model);
    return {
      envVars: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridge.port}`,
        ANTHROPIC_AUTH_TOKEN: 'custom-endpoint',
        ANTHROPIC_API_KEY: '',
        API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: upstreamModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: upstreamModel,
        ANTHROPIC_DEFAULT_OPUS_MODEL: upstreamModel,
      },
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  translateModelIdForSdk(_modelId: string): string {
    return 'default';
  }

  /**
   * Per-model thinking mode. Returns `'off'` for models that declare
   * `thinking: false` so the query-options builder skips the thinking
   * payload — critical for `anthropic-messages` endpoints because that
   * bridge forwards request bytes verbatim and a `thinking` field sent to
   * a non-thinking upstream model would 4xx.
   */
  getModelThinkingMode(modelId: string): 'off' | 'on' | 'granular' | undefined {
    const model = this.config.models.find((m) => m.id === modelId);
    if (!model) return undefined;
    const caps = resolveModelCapabilities(model, this.type);
    return caps.thinking ? 'on' : 'off';
  }

  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    return {
      isAuthenticated: true,
      method: 'api_key',
    };
  }

  async shutdown(): Promise<void> {
    for (const bridge of this.bridges.values()) bridge.stop();
    this.bridges.clear();
  }

  /** Snapshot of the underlying endpoint config (for RPC responses). */
  getConfig(): CustomEndpointConfig {
    return this.config;
  }

  /** Resolved type (with the legacy `openai-chat` default applied). */
  getType(): CustomEndpointType {
    return this.type;
  }

  private getOrCreateBridge(params: {
    baseUrl: string;
    apiKey?: string;
    caps: CustomEndpointModelCapabilities;
    model: CustomEndpointModel;
  }): CustomEndpointBridge {
    const key = [
      this.type,
      params.baseUrl,
      params.apiKey ?? '',
      params.model.id,
      params.caps.toolUse,
      params.caps.vision,
      params.caps.thinking,
      params.caps.streamUsage,
    ].join(' ');
    const existing = this.bridges.get(key);
    if (existing) return existing;
    const bridge = this.createBridgeForType(params);
    this.bridges.set(key, bridge);
    return bridge;
  }

  private createBridgeForType(params: {
    baseUrl: string;
    apiKey?: string;
    caps: CustomEndpointModelCapabilities;
    model: CustomEndpointModel;
  }): CustomEndpointBridge {
    const { baseUrl, apiKey, caps } = params;
    const fetchImpl = this.options.bridgeFetchImpl;
    switch (this.type) {
      case 'anthropic-messages': {
        const factory =
          this.options.bridgeFactories?.['anthropic-messages'] ??
          createAnthropicMessagesBridgeServer;
        return factory({
          baseUrl,
          apiKey,
          headers: this.config.headers,
          ...(fetchImpl ? { fetchImpl } : {}),
        });
      }
      case 'ollama-native': {
        const factory =
          this.options.bridgeFactories?.['ollama-native'] ?? createOllamaNativeBridgeServer;
        return factory({
          baseUrl,
          apiKey,
          headers: this.config.headers,
          toolUseSupported: caps.toolUse,
          modelContextWindow: caps.maxContextTokens,
          // Bind to loopback so other local users can't reach this bridge
          // with the configured upstream API key.
          hostname: '127.0.0.1',
          ...(fetchImpl ? { fetchImpl } : {}),
        });
      }
      case 'openai-chat':
      default: {
        const factory =
          this.options.bridgeFactories?.['openai-chat'] ??
          this.options.bridgeFactory ??
          createOpenAIChatBridgeServer;
        return factory({
          baseUrl,
          apiKey,
          headers: this.config.headers,
          toolUseSupported: caps.toolUse,
          visionSupported: caps.vision,
          thinkingSupported: caps.thinking,
          streamUsageSupported: caps.streamUsage,
          modelContextWindow: caps.maxContextTokens,
          ...(fetchImpl ? { fetchImpl } : {}),
        });
      }
    }
  }

  private toModelInfo(model: CustomEndpointModel): ModelInfo {
    const caps = resolveModelCapabilities(model, this.type);
    return {
      id: model.id,
      name: modelDisplayName(model),
      alias: model.id,
      family: this.config.id,
      provider: this.id,
      contextWindow: caps.maxContextTokens,
      description: `Custom endpoint ${this.displayName}`,
      releaseDate: '',
      available: true,
    };
  }
}

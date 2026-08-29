import type {
  ModelTier,
  Provider,
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderSdkConfig,
  ProviderSessionConfig,
} from '@hyperneo/shared/provider';
import type { ModelInfo } from '@hyperneo/shared';
import {
  CUSTOM_ENDPOINT_TYPE_CAPABILITY_DEFAULTS,
  DEFAULT_CUSTOM_ENDPOINT_CAPABILITIES,
  resolveAutoCompactPercent,
  resolveCustomEndpointType,
  THINKING_LEVEL_TOKENS,
  type CustomEndpointConfig,
  type CustomEndpointModel,
  type CustomEndpointModelCapabilities,
  type CustomEndpointType,
} from '@hyperneo/shared';
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
import { DEFAULT_PROBE_TIMEOUT_MS, normalizeBaseUrlForProbe } from './shared/credential-probe.js';
import { applyRecordedFailureToAuthStatus } from './provider-failure-store.js';
import { autoCompactReserveTokens } from '../agent/context-tracker.js';
import {
  createOllamaNativeBridgeServer,
  type OllamaNativeBridgeConfig,
  type OllamaNativeBridgeServer,
} from './ollama-native-bridge/server.js';

export const CUSTOM_ENDPOINT_PROVIDER_PREFIX = 'custom:';

export function customProviderIdFor(endpointId: string): string {
  return `${CUSTOM_ENDPOINT_PROVIDER_PREFIX}${endpointId}`;
}

export function isCustomEndpointProviderId(providerId: string): boolean {
  return providerId.startsWith(CUSTOM_ENDPOINT_PROVIDER_PREFIX);
}

interface CustomEndpointBridge {
  port: number;
  stop(): void;
  setSessionThinkingConfig?(
    sessionId: string,
    thinking: { type: 'enabled'; budget_tokens: number } | undefined
  ): void;
}

export interface CustomEndpointProviderOptions {
  bridgeFetchImpl?: typeof fetch;
  bridgeFactories?: {
    'openai-chat'?: (
      config: OpenAIChatBridgeConfig
    ) => OpenAIChatBridgeServer | Promise<OpenAIChatBridgeServer>;
    'anthropic-messages'?: (
      config: AnthropicMessagesBridgeConfig
    ) => AnthropicMessagesBridgeServer | Promise<AnthropicMessagesBridgeServer>;
    'ollama-native'?: (
      config: OllamaNativeBridgeConfig
    ) => OllamaNativeBridgeServer | Promise<OllamaNativeBridgeServer>;
  };
  bridgeFactory?: (
    config: OpenAIChatBridgeConfig
  ) => OpenAIChatBridgeServer | Promise<OpenAIChatBridgeServer>;
}

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

function autoCompactWindowForModel(
  providerId: string,
  caps: CustomEndpointModelCapabilities
): number | undefined {
  if (!Number.isFinite(caps.maxContextTokens) || caps.maxContextTokens <= 0) {
    return undefined;
  }
  if (typeof caps.autoCompactPercent === 'number' && Number.isFinite(caps.autoCompactPercent)) {
    return (
      Math.floor(
        (caps.maxContextTokens * resolveAutoCompactPercent(caps.autoCompactPercent)) / 100
      ) + autoCompactReserveTokens(providerId)
    );
  }
  return caps.maxContextTokens;
}

export class CustomEndpointProvider implements Provider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  private readonly config: CustomEndpointConfig;
  private readonly type: CustomEndpointType;
  private readonly options: CustomEndpointProviderOptions;
  private bridges = new Map<string, CustomEndpointBridge>();
  private bridgePromises = new Map<string, Promise<CustomEndpointBridge>>();
  private shutdownStarted = false;

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
    return Boolean(this.config.baseUrl);
  }

  private async probeEndpoint(): Promise<void> {
    const fetchImpl = this.options.bridgeFetchImpl ?? fetch;
    const baseUrl = normalizeBaseUrlForProbe(this.config.baseUrl);
    const probePath =
      this.type === 'ollama-native'
        ? '/api/tags'
        : this.type === 'anthropic-messages'
          ? '/v1/models'
          : '/models';
    const url = `${baseUrl}${probePath}`;

    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      if (this.type === 'anthropic-messages') {
        headers['x-api-key'] = this.config.apiKey;
      }
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }
    if (this.config.headers) Object.assign(headers, this.config.headers);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(
          `Custom endpoint '${this.config.id}' probe timed out after ${DEFAULT_PROBE_TIMEOUT_MS}ms`
        );
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Custom endpoint '${this.config.id}' probe failed: ${detail}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Custom endpoint '${this.config.id}' API key rejected (HTTP ${response.status})`
      );
    }
    if (!response.ok) {
      throw new Error(`Custom endpoint '${this.config.id}' probe failed (HTTP ${response.status})`);
    }
  }

  async getModels(): Promise<ModelInfo[]> {
    await this.probeEndpoint();
    void this.ensureBridgeStarted(this.getModelForTier('default') ?? 'default').catch(() => {});
    return this.config.models.map((model) => this.toModelInfo(model));
  }

  getCachedModels(): ModelInfo[] | null {
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
    const {
      key,
      params: { model, caps },
    } = this.bridgeParamsFor(modelId, sessionConfig);
    const bridge = this.bridges.get(key);
    if (!bridge) {
      throw new Error(
        `CustomEndpointProvider[${this.config.id}]: bridge not started. ` +
          'Await ensureBridgeStarted() before calling buildSdkConfig().'
      );
    }
    const upstreamModel = providerModelStringFor(model);
    const autoCompactWindow = autoCompactWindowForModel(this.id, caps);
    return {
      envVars: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridge.port}`,
        ANTHROPIC_AUTH_TOKEN: `custom-endpoint:${sessionConfig?.sessionId ?? 'default'}`,
        ANTHROPIC_API_KEY: '',
        API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: upstreamModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: upstreamModel,
        ANTHROPIC_DEFAULT_OPUS_MODEL: upstreamModel,
        ...(autoCompactWindow !== undefined
          ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(autoCompactWindow) }
          : {}),
      },
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  translateModelIdForSdk(_modelId: string): string {
    return 'default';
  }

  getModelThinkingMode(modelId: string): 'off' | 'on' | 'granular' | undefined {
    const model = this.config.models.find((m) => m.id === modelId);
    if (!model) return undefined;
    const caps = resolveModelCapabilities(model, this.type);
    return caps.thinking ? 'on' : 'off';
  }

  setSessionThinkingConfig(sessionId: string, thinkingLevel: string | undefined): void {
    const tokens = THINKING_LEVEL_TOKENS[thinkingLevel as keyof typeof THINKING_LEVEL_TOKENS];
    const thinking =
      tokens !== undefined
        ? ({ type: 'enabled' as const, budget_tokens: tokens } as const)
        : undefined;
    for (const bridge of this.bridges.values()) {
      if (bridge.setSessionThinkingConfig) {
        bridge.setSessionThinkingConfig(sessionId, thinking);
      }
    }
  }

  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    return applyRecordedFailureToAuthStatus(this.id, {
      isAuthenticated: true,
      method: 'api_key',
    });
  }

  async shutdown(): Promise<void> {
    this.shutdownStarted = true;
    this.bridgePromises.clear();
    for (const bridge of this.bridges.values()) bridge.stop();
    this.bridges.clear();
  }

  getConfig(): CustomEndpointConfig {
    return this.config;
  }

  getType(): CustomEndpointType {
    return this.type;
  }

  private bridgeParamsFor(
    modelId: string,
    sessionConfig?: ProviderSessionConfig
  ): {
    key: string;
    params: {
      baseUrl: string;
      apiKey?: string;
      caps: CustomEndpointModelCapabilities;
      model: CustomEndpointModel;
    };
  } {
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
    const params = { baseUrl, apiKey, caps, model };
    return { key: this.bridgeKey(params), params };
  }

  private bridgeKey(params: {
    baseUrl: string;
    apiKey?: string;
    caps: CustomEndpointModelCapabilities;
    model: CustomEndpointModel;
  }): string {
    return [
      this.type,
      params.baseUrl,
      params.apiKey ?? '',
      params.model.id,
      params.caps.toolUse,
      params.caps.vision,
      params.caps.thinking,
      params.caps.streamUsage,
      JSON.stringify(params.caps.chatTemplateKwargs ?? {}),
    ].join(' ');
  }

  async ensureBridgeStarted(modelId: string, sessionConfig?: ProviderSessionConfig): Promise<void> {
    const { params } = this.bridgeParamsFor(modelId, sessionConfig);
    await this.getOrCreateBridge(params);
  }

  private async getOrCreateBridge(params: {
    baseUrl: string;
    apiKey?: string;
    caps: CustomEndpointModelCapabilities;
    model: CustomEndpointModel;
  }): Promise<CustomEndpointBridge> {
    const key = this.bridgeKey(params);
    const existing = this.bridges.get(key);
    if (existing) return existing;
    const pending = this.bridgePromises.get(key);
    if (pending) return pending;
    const created = this.createBridgeForType(params);
    const ready = Promise.resolve(created).then(
      (bridge) => {
        if (this.shutdownStarted) {
          bridge.stop();
          this.bridgePromises.delete(key);
          return bridge;
        }
        this.bridges.set(key, bridge);
        this.bridgePromises.delete(key);
        return bridge;
      },
      (error) => {
        this.bridgePromises.delete(key);
        throw error;
      }
    );
    this.bridgePromises.set(key, ready);
    return ready;
  }

  private createBridgeForType(params: {
    baseUrl: string;
    apiKey?: string;
    caps: CustomEndpointModelCapabilities;
    model: CustomEndpointModel;
  }): CustomEndpointBridge | Promise<CustomEndpointBridge> {
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
          thinkingSupported: caps.thinking,
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
          ...(caps.chatTemplateKwargs ? { chatTemplateKwargs: caps.chatTemplateKwargs } : {}),
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
      autoCompactPercent: caps.autoCompactPercent,
      description: `Custom endpoint ${this.displayName}`,
      releaseDate: '',
      available: true,
    };
  }
}

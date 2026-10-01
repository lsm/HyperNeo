import type { ModelInfo } from '@hyperneo/shared';
import type {
  ListRemoteModelsOptions,
  ModelTier,
  Provider,
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderCredentials,
  ProviderSdkConfig,
  ProviderSessionConfig,
} from '@hyperneo/shared/provider';
import { applyRecordedFailureToAuthStatus } from './provider-failure-store.js';
import { probeAnthropicCompatCredentials } from './shared/credential-probe.js';
import { fetchRemoteModelList } from './shared/model-list.js';
import {
  createOpenAIChatBridgeServer,
  type OpenAIChatBridgeConfig,
  type OpenAIChatBridgeServer,
} from './openai-chat-bridge/server.js';
import {
  mergeDiscoveredModels,
  ProviderDiscoveryCache,
  providerDiscoveryFingerprint,
} from './shared/discovery-cache.js';

const ANTHROPIC_MESSAGES_MODEL_IDS = new Set([
  'minimax-m3',
  'minimax-m2.7',
  'qwen3.8-max',
  'qwen3.8-flash',
  'qwen3.7-plus',
]);

const UNSUPPORTED_RESPONSES_MODEL_IDS = new Set([
  'grok-4.7',
  'grok-4.6',
  'gpt-6-luna',
  'gpt-5.6-luna',
  'muse-spark-1.3-contributor',
  'muse-spark-1.2-contributor',
]);

const CONTEXT_WINDOWS: Record<string, number> = {
  'qwen3.7-plus': 256_000,
  'gpt-6-luna': 272_000,
  'gpt-5.6-luna': 272_000,
  'grok-4.7': 256_000,
  'grok-4.6': 256_000,
  'kimi-k3': 256_000,
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

const CATALOG: ReadonlyArray<readonly [string, string]> = [
  ['glm-5.3-flash', 'GLM-5.3-Flash'],
  ['glm-5.3', 'GLM-5.3'],
  ['glm-5.2', 'GLM-5.2'],
  ['kimi-k3', 'Kimi K3'],
  ['kimi-k2.7-code', 'Kimi K2.7 Code'],
  ['kimi-k2.6', 'Kimi K2.6'],
  ['longcat-2.0', 'LongCat-2.0'],
  ['longcat-2.5-preview-free', 'LongCat 2.5 Preview Free'],
  ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'],
  ['deepseek-v4-pro', 'DeepSeek V4 Pro'],
  ['deepseek-v4-flash', 'DeepSeek V4 Flash'],
  ['deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision Exp'],
  ['mimo-v2.6-flash', 'MiMo-V2.6-Flash'],
  ['mimo-v2.6-pro', 'MiMo-V2.6-Pro'],
  ['mimo-v2.5', 'MiMo-V2.5'],
  ['mimo-v2.5-pro', 'MiMo-V2.5-Pro'],
  ['minimax-m3', 'MiniMax M3'],
  ['minimax-m2.7', 'MiniMax M2.7'],
  ['qwen3.8-max', 'Qwen3.8 Max'],
  ['qwen3.8-flash', 'Qwen3.8 Flash'],
  ['qwen3.7-plus', 'Qwen3.7 Plus'],
  ['hy4-preview', 'Hy4 preview'],
  ['hy3', 'Hy3'],
  ['space-bunny-free', 'Space Bunny Free'],
];

export interface OpencodeProviderOptions {
  bridgeFactory?: (
    config: OpenAIChatBridgeConfig
  ) => OpenAIChatBridgeServer | Promise<OpenAIChatBridgeServer>;
}

export class OpencodeProvider implements Provider {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode Go';

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    extendedThinking: false,
    thinkingModes: 'off',
    maxContextWindow: 256_000,
    functionCalling: true,
    vision: true,
  };

  static readonly BASE_URL = 'https://opencode.ai/zen/go';
  static readonly CHAT_BASE_URL = 'https://opencode.ai/zen/go/v1';
  static readonly MODEL_LIST_URL = 'https://opencode.ai/zen/go/v1/models';
  static readonly CLIENT_USER_AGENT = 'hyperneo/1.0';
  static readonly SESSION_TOKEN_PREFIX = 'opencode';
  static readonly DISCOVERY_SESSION_ID = 'hyperneo-daemon';

  static readonly MODELS: ModelInfo[] = CATALOG.map(([id, name]) => ({
    id,
    name,
    alias: `opencode-${id}`,
    family: 'opencode',
    provider: 'opencode',
    contextWindow: CONTEXT_WINDOWS[id] ?? DEFAULT_CONTEXT_WINDOW,
    preferContextWindowMetadata: true,
    description: `${name} via OpenCode Go`,
    releaseDate: '',
    available: true,
  }));

  private credentials: ProviderCredentials | null = null;
  private credentialSignature: string | undefined;
  private readonly probeCache = new Map<string, { at: number; result: Promise<void> }>();
  private readonly discoveryCache = new ProviderDiscoveryCache();
  private readonly bridges = new Map<string, OpenAIChatBridgeServer>();
  private readonly bridgePromises = new Map<string, Promise<OpenAIChatBridgeServer>>();
  private discoveredModelIds = new Set<string>();
  private shutdownStarted = false;
  private static readonly PROBE_TTL_MS = 30_000;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: OpencodeProviderOptions = {}
  ) {}

  setCredentials(credentials: ProviderCredentials): void {
    const signature = JSON.stringify(credentials);
    if (signature !== this.credentialSignature) {
      this.stopBridges();
      this.probeCache.clear();
      this.clearModelCache();
    }
    this.credentialSignature = signature;
    this.credentials = credentials;
  }

  clearModelCache(): void {
    this.discoveryCache.clear();
    this.discoveredModelIds = new Set<string>();
  }

  getCredentials(): ProviderCredentials | null {
    return this.credentials;
  }

  isAvailable(): boolean {
    return !!this.getApiKey();
  }

  getApiKey(): string | undefined {
    return (
      this.env.OPENCODE_API_KEY ||
      this.env.OPENCODE_GO_API_KEY ||
      (this.credentials?.type === 'api_key' ? this.credentials.apiKey : undefined)
    );
  }

  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    const apiKey = this.getApiKey();
    return applyRecordedFailureToAuthStatus(this.id, {
      isAuthenticated: !!apiKey,
      method: 'api_key',
      error: apiKey
        ? undefined
        : 'Set OPENCODE_API_KEY with an OpenCode Go key to enable OpenCode Go models.',
    });
  }

  static clientHeaders(sessionId?: string): Record<string, string> {
    return {
      'User-Agent': OpencodeProvider.CLIENT_USER_AGENT,
      'x-opencode-session': sessionId?.trim() || OpencodeProvider.DISCOVERY_SESSION_ID,
    };
  }

  static customHeadersLine(sessionId?: string): string {
    return Object.entries(OpencodeProvider.clientHeaders(sessionId))
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n');
  }

  usesAnthropicMessages(modelId: string): boolean {
    return ANTHROPIC_MESSAGES_MODEL_IDS.has(modelId.trim().toLowerCase());
  }

  private supportsModelId(modelId: string): boolean {
    return !UNSUPPORTED_RESPONSES_MODEL_IDS.has(modelId.trim().toLowerCase());
  }

  contextWindowFor(modelId: string): number {
    const known = CONTEXT_WINDOWS[modelId.trim().toLowerCase()];
    if (known) return known;
    const catalogued = OpencodeProvider.MODELS.find((model) => model.id === modelId);
    return catalogued?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  }

  private async verifyCredentials(baseUrl: string, apiKey: string): Promise<void> {
    const cacheKey = `${baseUrl}::${apiKey}`;
    const cached = this.probeCache.get(cacheKey);
    if (cached && Date.now() - cached.at < OpencodeProvider.PROBE_TTL_MS) {
      await cached.result;
      return;
    }
    const result = probeAnthropicCompatCredentials({
      baseUrl,
      apiKey,
      model: 'minimax-m3',
      providerName: 'OpenCode Go',
      headers: OpencodeProvider.clientHeaders(),
      fetchImpl: this.fetchImpl,
    })
      .then(() => undefined)
      .catch((err) => {
        this.probeCache.delete(cacheKey);
        throw err;
      });
    this.probeCache.set(cacheKey, { at: Date.now(), result });
    await result;
  }

  async getModels(): Promise<ModelInfo[]> {
    const apiKey = this.getApiKey();
    if (!apiKey) return [];
    try {
      await this.verifyCredentials(OpencodeProvider.BASE_URL, apiKey);
    } catch {
      return OpencodeProvider.MODELS;
    }
    try {
      const discovered = await this.listRemoteModels();
      const staticBaseIds = new Set(OpencodeProvider.MODELS.map((model) => model.id));
      return mergeDiscoveredModels(
        OpencodeProvider.MODELS,
        discovered.filter((model) => !staticBaseIds.has(model.id))
      );
    } catch {
      return OpencodeProvider.MODELS;
    }
  }

  private discoveryFingerprint(): string {
    return providerDiscoveryFingerprint({
      baseUrl: OpencodeProvider.MODEL_LIST_URL,
      credentialKey: this.getApiKey(),
    });
  }

  async listRemoteModels(options: ListRemoteModelsOptions = {}): Promise<ModelInfo[]> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('OpenCode Go API key not configured');
    const fingerprint = this.discoveryFingerprint();
    if (!options.force) {
      const cached = this.discoveryCache.get(fingerprint);
      if (cached) return cached;
    }
    const models = await fetchRemoteModelList({
      url: OpencodeProvider.MODEL_LIST_URL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...OpencodeProvider.clientHeaders(),
      },
      fetchImpl: this.fetchImpl,
    });
    const discovered = models
      .filter((model) => this.supportsModelId(model.id))
      .map((model) => this.toRemoteModelInfo(model));
    this.discoveredModelIds = new Set(discovered.map((model) => model.id));
    this.discoveryCache.set(fingerprint, discovered);
    return discovered;
  }

  private toRemoteModelInfo(model: { id: string; name?: string }): ModelInfo {
    const staticModel = OpencodeProvider.MODELS.find((candidate) => candidate.id === model.id);
    if (staticModel) return staticModel;
    return {
      id: model.id,
      name: model.name ?? model.id,
      alias: `opencode-${model.id}`,
      family: 'opencode',
      provider: this.id,
      contextWindow: this.contextWindowFor(model.id),
      preferContextWindowMetadata: true,
      description: `${model.name ?? model.id} via OpenCode Go`,
      releaseDate: '',
      available: true,
    };
  }

  ownsModel(modelId: string): boolean {
    const normalized = modelId.trim();
    if (!this.supportsModelId(normalized)) return false;
    return (
      OpencodeProvider.MODELS.some((model) => model.id === normalized) ||
      this.discoveredModelIds.has(normalized)
    );
  }

  getModelForTier(_tier: ModelTier): string | undefined {
    return 'glm-5.3';
  }

  getTitleGenerationModel(): string {
    return 'glm-5.3-flash';
  }

  static sessionAuthToken(sessionId?: string): string {
    return `${OpencodeProvider.SESSION_TOKEN_PREFIX}:${
      sessionId?.trim() || OpencodeProvider.DISCOVERY_SESSION_ID
    }`;
  }

  async ensureBridgeStarted(modelId: string): Promise<void> {
    if (this.usesAnthropicMessages(modelId)) return;
    if (this.bridges.has(modelId)) return;
    const inFlight = this.bridgePromises.get(modelId);
    if (inFlight) {
      await inFlight;
      return;
    }
    const apiKey = this.getApiKey();
    const factory = this.options.bridgeFactory ?? createOpenAIChatBridgeServer;
    const ready = Promise.resolve(
      factory({
        baseUrl: OpencodeProvider.CHAT_BASE_URL,
        ...(apiKey ? { apiKey } : {}),
        sessionTokenPrefix: OpencodeProvider.SESSION_TOKEN_PREFIX,
        sessionHeaders: (sessionId) => OpencodeProvider.clientHeaders(sessionId),
        toolUseSupported: true,
        visionSupported: true,
        thinkingSupported: false,
        modelContextWindow: this.contextWindowFor(modelId),
      })
    ).then(
      (bridge) => {
        this.bridgePromises.delete(modelId);
        if (this.shutdownStarted) {
          bridge.stop();
          return bridge;
        }
        this.bridges.set(modelId, bridge);
        return bridge;
      },
      (error: unknown) => {
        this.bridgePromises.delete(modelId);
        throw error;
      }
    );
    this.bridgePromises.set(modelId, ready);
    await ready;
  }

  buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    const apiKey = sessionConfig?.apiKey || this.getApiKey();
    if (!apiKey) {
      throw new Error('OpenCode Go API key not configured');
    }
    const contextWindow = this.contextWindowFor(modelId);
    const routingEnvVars: Record<string, string> = {
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindow),
      ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId,
      ANTHROPIC_DEFAULT_SONNET_MODEL: modelId,
      ANTHROPIC_DEFAULT_OPUS_MODEL: modelId,
    };

    if (this.usesAnthropicMessages(modelId)) {
      return {
        envVars: {
          ANTHROPIC_BASE_URL: sessionConfig?.baseUrl || OpencodeProvider.BASE_URL,
          ANTHROPIC_AUTH_TOKEN: apiKey,
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_CUSTOM_HEADERS: OpencodeProvider.customHeadersLine(sessionConfig?.sessionId),
          ...routingEnvVars,
        },
        isAnthropicCompatible: true,
        apiVersion: 'v1',
      };
    }

    const bridge = this.bridges.get(modelId);
    if (!bridge) {
      throw new Error(
        `opencode: bridge not started for model '${modelId}'. ` +
          'Await ensureBridgeStarted() before calling buildSdkConfig().'
      );
    }
    return {
      envVars: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridge.port}`,
        ANTHROPIC_AUTH_TOKEN: OpencodeProvider.sessionAuthToken(sessionConfig?.sessionId),
        ANTHROPIC_API_KEY: '',
        ...routingEnvVars,
      },
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  translateModelIdForSdk(_modelId: string): string {
    return 'default';
  }

  private stopBridges(): void {
    this.bridgePromises.clear();
    for (const bridge of this.bridges.values()) bridge.stop();
    this.bridges.clear();
  }

  async shutdown(): Promise<void> {
    this.shutdownStarted = true;
    this.stopBridges();
  }
}

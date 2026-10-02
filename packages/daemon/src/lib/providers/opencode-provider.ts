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
import {
  DEFAULT_CONTEXT_WINDOW,
  extractOpencodeGoCatalog,
  FALLBACK_ANTHROPIC_WIRE_IDS,
  FALLBACK_RESPONSES_WIRE_IDS,
  fallbackCatalog,
  fallbackWireFor,
  MODEL_CATALOGUE,
  type OpencodeModelMetadata,
} from './opencode-catalogue.js';

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
    extendedThinking: true,
    thinkingModes: 'granular',
    maxContextWindow: 256_000,
    functionCalling: true,
    vision: true,
  };

  static readonly BASE_URL = 'https://opencode.ai/zen/go';
  static readonly CHAT_BASE_URL = 'https://opencode.ai/zen/go/v1';
  static readonly MODEL_LIST_URL = 'https://opencode.ai/zen/go/v1/models';
  static readonly CATALOG_URL = 'https://models.opencode.ai/api.json';
  static readonly CATALOG_CACHE_TTL_MS = 60 * 60 * 1000;
  static readonly CLIENT_USER_AGENT = 'hyperneo/1.0';
  static readonly SESSION_TOKEN_PREFIX = 'opencode';
  static readonly DISCOVERY_SESSION_ID = 'hyperneo-daemon';

  static readonly MODELS: ModelInfo[] = MODEL_CATALOGUE.map((entry) =>
    OpencodeProvider.modelInfoFor({
      id: entry.id,
      name: entry.name,
      contextWindow: entry.context,
      releaseDate: entry.released,
      wire: FALLBACK_RESPONSES_WIRE_IDS.has(entry.id)
        ? 'openai-responses'
        : FALLBACK_ANTHROPIC_WIRE_IDS.has(entry.id)
          ? 'anthropic-messages'
          : 'openai-chat',
    })
  );

  private static modelInfoFor(metadata: OpencodeModelMetadata): ModelInfo {
    return {
      id: metadata.id,
      name: metadata.name ?? metadata.id,
      alias: `opencode-${metadata.id}`,
      family: 'opencode',
      provider: 'opencode',
      contextWindow: metadata.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      preferContextWindowMetadata: true,
      thinkingModes: 'granular',
      description: `${metadata.name ?? metadata.id} via OpenCode Go`,
      releaseDate: metadata.releaseDate ?? '',
      available: true,
    };
  }

  private credentials: ProviderCredentials | null = null;
  private credentialSignature: string | undefined;
  private credentialEpoch = 0;
  private readonly probeCache = new Map<string, { at: number; result: Promise<void> }>();
  private readonly discoveryCache = new ProviderDiscoveryCache();
  private readonly bridges = new Map<string, OpenAIChatBridgeServer>();
  private readonly bridgePromises = new Map<string, Promise<OpenAIChatBridgeServer>>();
  private discoveredModelIds = new Set<string>();
  private catalog: { at: number; models: Map<string, OpencodeModelMetadata> } | null = null;
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
      this.credentialEpoch += 1;
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
    this.catalog = null;
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

  private catalogUrl(): string {
    return this.env.OPENCODE_MODELS_URL || OpencodeProvider.CATALOG_URL;
  }

  private async loadCatalog(): Promise<Map<string, OpencodeModelMetadata>> {
    const cached = this.catalog;
    if (cached && Date.now() - cached.at < OpencodeProvider.CATALOG_CACHE_TTL_MS) {
      return cached.models;
    }
    const models = await this.fetchCatalog();
    this.catalog = { at: Date.now(), models };
    return models;
  }

  private async fetchCatalog(): Promise<Map<string, OpencodeModelMetadata>> {
    try {
      const response = await this.fetchImpl(this.catalogUrl(), {
        headers: { 'User-Agent': OpencodeProvider.CLIENT_USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return fallbackCatalog();
      const provider = extractOpencodeGoCatalog(await response.json());
      return provider.size > 0 ? provider : fallbackCatalog();
    } catch {
      return fallbackCatalog();
    }
  }

  async modelMetadata(modelId: string): Promise<OpencodeModelMetadata> {
    const normalized = modelId.trim();
    const models = await this.loadCatalog();
    return (
      models.get(normalized) ?? {
        id: normalized,
        wire: fallbackWireFor(normalized),
      }
    );
  }

  usesAnthropicMessages(modelId: string): boolean {
    const normalized = modelId.trim();
    if (FALLBACK_ANTHROPIC_WIRE_IDS.has(normalized)) return true;
    return this.catalog?.models.get(normalized)?.wire === 'anthropic-messages';
  }

  supportsModelId(modelId: string): boolean {
    const normalized = modelId.trim();
    if (FALLBACK_RESPONSES_WIRE_IDS.has(normalized)) return false;
    const catalogued = this.catalog?.models.get(normalized);
    return catalogued ? catalogued.wire !== 'openai-responses' : true;
  }

  contextWindowFor(modelId: string): number {
    const normalized = modelId.trim();
    const catalogued = this.catalog?.models.get(normalized);
    if (catalogued?.contextWindow) return catalogued.contextWindow;
    const baked = MODEL_CATALOGUE.find((entry) => entry.id === normalized);
    return baked?.context ?? DEFAULT_CONTEXT_WINDOW;
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

  private catalogueModels(): ModelInfo[] {
    const catalogued = this.catalog?.models;
    if (!catalogued || catalogued.size === 0) return OpencodeProvider.MODELS;
    const ids = new Set([...MODEL_CATALOGUE.map((entry) => entry.id), ...catalogued.keys()]);
    const models: ModelInfo[] = [];
    for (const id of ids) {
      const metadata = catalogued.get(id);
      if (!metadata || metadata.wire === 'openai-responses') continue;
      models.push(OpencodeProvider.modelInfoFor(metadata));
    }
    return models;
  }

  async getModels(): Promise<ModelInfo[]> {
    const apiKey = this.getApiKey();
    if (!apiKey) return [];
    await this.loadCatalog();
    try {
      await this.verifyCredentials(OpencodeProvider.BASE_URL, apiKey);
    } catch {
      return OpencodeProvider.MODELS;
    }
    const catalogue = this.catalogueModels();
    try {
      const discovered = await this.listRemoteModels();
      const staticBaseIds = new Set(catalogue.map((model) => model.id));
      return mergeDiscoveredModels(
        catalogue,
        discovered.filter((model) => !staticBaseIds.has(model.id))
      );
    } catch {
      return catalogue;
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
    await this.loadCatalog();
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
    const catalogued = this.catalog?.models.get(model.id);
    return OpencodeProvider.modelInfoFor({
      id: model.id,
      name: model.name ?? catalogued?.name ?? model.id,
      ...(catalogued?.contextWindow ? { contextWindow: catalogued.contextWindow } : {}),
      ...(catalogued?.releaseDate ? { releaseDate: catalogued.releaseDate } : {}),
      wire: catalogued?.wire ?? fallbackWireFor(model.id),
    });
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

  private bridgeKey(modelId: string, apiKey: string | undefined, baseUrl: string): string {
    return `${modelId}::${apiKey ?? ''}::${baseUrl}`;
  }

  private bridgeApiKeyFor(sessionConfig?: ProviderSessionConfig): string | undefined {
    return sessionConfig?.apiKey || this.getApiKey();
  }

  private bridgeBaseUrlFor(sessionConfig?: ProviderSessionConfig): string {
    return sessionConfig?.baseUrl || OpencodeProvider.CHAT_BASE_URL;
  }

  async ensureBridgeStarted(modelId: string, sessionConfig?: ProviderSessionConfig): Promise<void> {
    if (this.usesAnthropicMessages(modelId)) return;
    const apiKey = this.bridgeApiKeyFor(sessionConfig);
    const baseUrl = this.bridgeBaseUrlFor(sessionConfig);
    const key = this.bridgeKey(modelId, apiKey, baseUrl);
    if (this.bridges.has(key)) return;
    const inFlight = this.bridgePromises.get(key);
    if (inFlight) {
      await inFlight;
      return;
    }
    const epoch = this.credentialEpoch;
    const factory = this.options.bridgeFactory ?? createOpenAIChatBridgeServer;
    const ready = Promise.resolve(
      factory({
        baseUrl: this.bridgeBaseUrlFor(sessionConfig),
        ...(apiKey ? { apiKey } : {}),
        sessionTokenPrefix: OpencodeProvider.SESSION_TOKEN_PREFIX,
        sessionHeaders: (sessionId) => OpencodeProvider.clientHeaders(sessionId),
        toolUseSupported: true,
        visionSupported: true,
        thinkingSupported: true,
        modelContextWindow: this.contextWindowFor(modelId),
      })
    ).then(
      (bridge) => {
        this.bridgePromises.delete(key);
        if (this.shutdownStarted || this.credentialEpoch !== epoch) {
          bridge.stop();
          throw new Error('OpenCode Go credentials changed while the bridge was starting');
        }
        this.bridges.set(key, bridge);
        return bridge;
      },
      (error: unknown) => {
        this.bridgePromises.delete(key);
        throw error;
      }
    );
    this.bridgePromises.set(key, ready);
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

    const bridge = this.bridges.get(
      this.bridgeKey(
        modelId,
        this.bridgeApiKeyFor(sessionConfig),
        this.bridgeBaseUrlFor(sessionConfig)
      )
    );
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

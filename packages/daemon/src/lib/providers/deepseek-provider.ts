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
import { fetchRemoteModelList, type RemoteModelListEntry } from './shared/model-list.js';

export class DeepSeekProvider implements Provider {
  readonly id = 'deepseek';
  readonly displayName = 'DeepSeek';

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    extendedThinking: true,
    thinkingModes: 'granular',
    maxContextWindow: 1_000_000,
    functionCalling: true,
    vision: false,
  };

  static readonly BASE_URL = 'https://api.deepseek.com/anthropic';
  static readonly MODEL_LIST_URL = 'https://api.deepseek.com/models';
  static readonly DEFAULT_MODEL = 'deepseek-v4-pro';

  static readonly MODELS: ModelInfo[] = [
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      alias: 'deepseek-pro',
      family: 'deepseek',
      provider: 'deepseek',
      contextWindow: 1_000_000,
      preferContextWindowMetadata: true,
      description: 'DeepSeek V4 Pro · Flagship reasoning model',
      releaseDate: '2026-04-24',
      available: true,
      thinkingModes: 'granular',
    },
    {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      alias: 'deepseek-flash',
      family: 'deepseek',
      provider: 'deepseek',
      contextWindow: 1_000_000,
      preferContextWindowMetadata: true,
      description: 'DeepSeek V4 Flash · Fast, cost-efficient reasoning model',
      releaseDate: '2026-04-24',
      available: true,
      thinkingModes: 'granular',
    },
  ];

  private credentials: ProviderCredentials | null = null;
  private readonly probeCache = new Map<string, { at: number; result: Promise<void> }>();
  private readonly modelListCache = new Map<string, RemoteModelListEntry>();
  private static readonly PROBE_TTL_MS = 30_000;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  setCredentials(credentials: ProviderCredentials): void {
    this.credentials = credentials;
    this.probeCache.clear();
    this.clearModelCache();
  }

  clearModelCache(): void {
    this.modelListCache.clear();
  }

  getCredentials(): ProviderCredentials | null {
    return this.credentials;
  }

  getApiKey(): string | undefined {
    return (
      this.env.DEEPSEEK_API_KEY ||
      (this.credentials?.type === 'api_key' ? this.credentials.apiKey : undefined)
    );
  }

  isAvailable(): boolean {
    return !!this.getApiKey();
  }

  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    const apiKey = this.getApiKey();
    return applyRecordedFailureToAuthStatus(this.id, {
      isAuthenticated: !!apiKey,
      method: 'api_key',
      error: apiKey ? undefined : 'Set DEEPSEEK_API_KEY to enable DeepSeek models.',
    });
  }

  private async verifyCredentials(baseUrl: string, apiKey: string): Promise<void> {
    const cacheKey = `${baseUrl}::${apiKey}`;
    const cached = this.probeCache.get(cacheKey);
    if (cached && Date.now() - cached.at < DeepSeekProvider.PROBE_TTL_MS) {
      await cached.result;
      return;
    }
    const result = probeAnthropicCompatCredentials({
      baseUrl,
      apiKey,
      model: DeepSeekProvider.DEFAULT_MODEL,
      providerName: 'DeepSeek',
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
    await this.verifyCredentials(DeepSeekProvider.BASE_URL, apiKey);
    return DeepSeekProvider.MODELS;
  }

  async listRemoteModels(options: ListRemoteModelsOptions = {}): Promise<ModelInfo[]> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('DeepSeek API key not configured');
    const models = await fetchRemoteModelList({
      url: DeepSeekProvider.MODEL_LIST_URL,
      headers: { Authorization: `Bearer ${apiKey}` },
      force: options.force,
      cache: this.modelListCache,
    });
    return models
      .filter((model) => this.ownsModel(model.id))
      .map((model) => this.toRemoteModelInfo(model));
  }

  private toRemoteModelInfo(model: { id: string; name?: string }): ModelInfo {
    const staticModel = DeepSeekProvider.MODELS.find(
      (candidate) => candidate.id === DeepSeekProvider.resolveModelId(model.id)
    );
    if (staticModel) return staticModel;
    return {
      id: model.id,
      name: model.name ?? model.id,
      alias: model.id,
      family: 'deepseek',
      provider: this.id,
      contextWindow: this.capabilities.maxContextWindow,
      preferContextWindowMetadata: true,
      thinkingModes: this.capabilities.thinkingModes,
      description: `${model.name ?? model.id} via DeepSeek`,
      releaseDate: '',
      available: true,
    };
  }

  ownsModel(modelId: string): boolean {
    return DeepSeekProvider.resolveModelId(modelId) !== undefined;
  }

  private static resolveModelId(modelId: string): string | undefined {
    const normalized = modelId.toLowerCase();
    const staticModel = DeepSeekProvider.MODELS.find(
      (model) => model.id.toLowerCase() === normalized || model.alias.toLowerCase() === normalized
    )?.id;
    if (staticModel) return staticModel;
    return normalized.startsWith('deepseek-') && !normalized.includes(':') ? modelId : undefined;
  }

  getModelForTier(tier: ModelTier): string | undefined {
    return tier === 'opus' ? 'deepseek-v4-pro' : 'deepseek-v4-flash';
  }

  buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    const apiKey = sessionConfig?.apiKey || this.getApiKey();
    if (!apiKey) throw new Error('DeepSeek API key not configured');

    const routingModelId =
      DeepSeekProvider.resolveModelId(modelId) ?? DeepSeekProvider.DEFAULT_MODEL;
    return {
      envVars: {
        ANTHROPIC_BASE_URL: sessionConfig?.baseUrl || DeepSeekProvider.BASE_URL,
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_API_KEY: '',
        API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: routingModelId,
        ANTHROPIC_DEFAULT_SONNET_MODEL: routingModelId,
        ANTHROPIC_DEFAULT_OPUS_MODEL: routingModelId,
      },
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  translateModelIdForSdk(modelId: string): string {
    const resolvedModelId = DeepSeekProvider.resolveModelId(modelId);
    if (resolvedModelId === 'deepseek-v4-pro') return 'claude-opus-4-6[1m]';
    if (resolvedModelId === 'deepseek-v4-flash') return 'claude-sonnet-4-6[1m]';
    return resolvedModelId ?? 'claude-sonnet-4-6[1m]';
  }

  getTitleGenerationModel(): string {
    return 'deepseek-v4-flash';
  }

  async shutdown(): Promise<void> {}
}

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
import type { ModelInfo } from '@hyperneo/shared';
import { probeAnthropicCompatCredentials } from './shared/credential-probe.js';
import { applyRecordedFailureToAuthStatus } from './provider-failure-store.js';
import { fetchRemoteModelList, type RemoteModelListEntry } from './shared/model-list.js';

export class GlmProvider implements Provider {
  readonly id = 'glm';
  readonly displayName = 'Z.ai';

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    extendedThinking: true,
    thinkingModes: 'granular',
    maxContextWindow: 1_000_000,
    functionCalling: true,
    vision: true,
  };

  static readonly BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
  static readonly MODEL_LIST_URL = 'https://open.bigmodel.cn/api/paas/v4/models';

  static readonly MODELS: ModelInfo[] = [
    {
      id: 'glm-5',
      name: 'GLM-5',
      alias: 'glm',
      family: 'glm',
      provider: 'glm',
      contextWindow: 200000,
      preferContextWindowMetadata: true,
      description: "GLM-5 · Zhipu AI's Next-Generation Frontier Model",
      releaseDate: '2026-02-11',
      available: true,
    },
    {
      id: 'glm-5.1',
      name: 'GLM-5.1',
      alias: 'glm-5.1',
      family: 'glm',
      provider: 'glm',
      contextWindow: 200000,
      preferContextWindowMetadata: true,
      description: 'GLM-5.1 · Enhanced reasoning and instruction following',
      releaseDate: '2026-04-08',
      available: true,
    },
    {
      id: 'glm-5.2[1m]',
      name: 'GLM-5.2',
      alias: 'glm-5.2',
      family: 'glm',
      provider: 'glm',
      contextWindow: 1_000_000,
      preferContextWindowMetadata: true,
      description: 'GLM-5.2 · 1M context window, recommended thinking mode "max"',
      releaseDate: '2026-06-10',
      available: true,
    },
    {
      id: 'glm-5.3[1m]',
      name: 'GLM-5.3',
      alias: 'glm-5.3',
      family: 'glm',
      provider: 'glm',
      contextWindow: 1_000_000,
      preferContextWindowMetadata: true,
      description: 'GLM-5.3 · 1M context window, post-trained for long-horizon coding',
      releaseDate: '2026-08-14',
      available: true,
    },
    {
      id: 'glm-5-turbo',
      name: 'GLM-5-Turbo',
      alias: 'glm-5-turbo',
      family: 'glm',
      provider: 'glm',
      contextWindow: 200000,
      preferContextWindowMetadata: true,
      description: 'GLM-5-Turbo · Optimized for long-chain agent tasks and tool calling',
      releaseDate: '2026-03-15',
      available: true,
    },
    {
      id: 'glm-5v-turbo',
      name: 'GLM-5V-Turbo',
      alias: 'glm-5v-turbo',
      family: 'glm',
      provider: 'glm',
      contextWindow: 200000,
      preferContextWindowMetadata: true,
      description: 'GLM-5V-Turbo · Vision-capable turbo model optimized for multimodal agent tasks',
      releaseDate: '2026-05-01',
      available: true,
    },
    {
      id: 'glm-4.7',
      name: 'GLM-4.7',
      alias: 'glm-4.7',
      family: 'glm',
      provider: 'glm',
      contextWindow: 200000,
      preferContextWindowMetadata: true,
      description: 'GLM-4.7 · Zhipu AI high-performance model',
      releaseDate: '2025-12-01',
      available: true,
    },
  ];

  private static readonly CONTEXT_WINDOW_BY_MODEL_ID: Record<string, number> = Object.fromEntries(
    GlmProvider.MODELS.map((m) => [m.id, m.contextWindow])
  );

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

  isAvailable(): boolean {
    return !!this.getApiKey();
  }

  getApiKey(): string | undefined {
    return (
      this.env.GLM_API_KEY ||
      this.env.ZHIPU_API_KEY ||
      (this.credentials?.type === 'api_key' ? this.credentials.apiKey : undefined)
    );
  }

  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    const apiKey = this.getApiKey();
    return applyRecordedFailureToAuthStatus(this.id, {
      isAuthenticated: !!apiKey,
      method: 'api_key',
      error: apiKey ? undefined : 'Set GLM_API_KEY or ZHIPU_API_KEY to enable GLM models.',
    });
  }

  private async verifyCredentials(baseUrl: string, apiKey: string): Promise<void> {
    const cacheKey = `${baseUrl}::${apiKey}`;
    const cached = this.probeCache.get(cacheKey);
    if (cached && Date.now() - cached.at < GlmProvider.PROBE_TTL_MS) {
      await cached.result;
      return;
    }
    const result = probeAnthropicCompatCredentials({
      baseUrl,
      apiKey,
      model: 'glm-5-turbo',
      providerName: 'Z.ai',
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
    await this.verifyCredentials(GlmProvider.BASE_URL, apiKey);
    return GlmProvider.MODELS;
  }

  async listRemoteModels(options: ListRemoteModelsOptions = {}): Promise<ModelInfo[]> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('Z.ai API key not configured');
    const models = await fetchRemoteModelList({
      url: GlmProvider.MODEL_LIST_URL,
      headers: { Authorization: `Bearer ${apiKey}` },
      force: options.force,
      cache: this.modelListCache,
    });
    return models
      .filter((model) => this.ownsModel(model.id))
      .map((model) => this.toRemoteModelInfo(model));
  }

  private toRemoteModelInfo(model: { id: string; name?: string }): ModelInfo {
    const baseId = model.id.toLowerCase().replace(/(\[1m\])+$/, '');
    const staticModel = GlmProvider.MODELS.find(
      (candidate) => candidate.id.toLowerCase().replace(/(\[1m\])+$/, '') === baseId
    );
    if (staticModel) return { ...staticModel, id: model.id };
    return {
      id: model.id,
      name: model.name ?? model.id,
      alias: model.id,
      family: 'glm',
      provider: this.id,
      contextWindow: 200_000,
      preferContextWindowMetadata: true,
      thinkingModes: this.capabilities.thinkingModes,
      description: `${model.name ?? model.id} via Z.ai`,
      releaseDate: '',
      available: true,
    };
  }

  ownsModel(modelId: string): boolean {
    return modelId === 'glm-5' || modelId.toLowerCase().startsWith('glm-');
  }

  getModelForTier(_tier: ModelTier): string | undefined {
    return 'glm-5-turbo';
  }

  buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    const apiKey = sessionConfig?.apiKey || this.getApiKey();
    if (!apiKey) {
      throw new Error('Z.ai API key not configured');
    }

    const baseUrl = sessionConfig?.baseUrl || GlmProvider.BASE_URL;

    const normalisedModelId = modelId.toLowerCase();

    const baseModelId = normalisedModelId.replace(/(\[1m\])+$/, '');
    const ONE_M_MODEL_IDS = new Set(['glm-5.2', 'glm-5.3']);
    const routingModelId = ONE_M_MODEL_IDS.has(baseModelId)
      ? `${baseModelId}[1m]`
      : baseModelId.startsWith('glm-')
        ? baseModelId
        : 'glm-5-turbo';

    const contextWindow = GlmProvider.CONTEXT_WINDOW_BY_MODEL_ID[routingModelId] ?? 200_000;

    const envVars: Record<string, string> = {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindow),
      ANTHROPIC_DEFAULT_HAIKU_MODEL: routingModelId,
      ANTHROPIC_DEFAULT_SONNET_MODEL: routingModelId,
      ANTHROPIC_DEFAULT_OPUS_MODEL: routingModelId,
    };

    return {
      envVars,
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  translateModelIdForSdk(_modelId: string): string {
    return 'default';
  }

  getTitleGenerationModel(): string {
    return 'glm-5-turbo';
  }
}

import type {
  ListRemoteModelsOptions,
  Provider,
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderCredentials,
  ProviderSdkConfig,
  ProviderSessionConfig,
  ModelTier,
} from '@hyperneo/shared/provider';
import type { ModelInfo } from '@hyperneo/shared';

interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  created?: number;
  top_provider?: {
    context_length?: number;
  };
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModel[];
}

class OpenRouterModelAuthError extends Error {}

const CURATED_PROVIDER_PREFIXES = [
  'anthropic/',
  'openai/',
  'google/',
  'deepseek/',
  'meta-llama/',
  'mistralai/',
  'xai/',
  'cohere/',
  'qwen/',
] as const;

const SYSTEM_MODEL_PREFIXES = ['~', 'openrouter/'] as const;

function isProbablyOpenRouterKey(apiKey: string): boolean {
  return apiKey.trim().startsWith('sk-or-');
}

function providerModelAlias(modelId: string): string {
  if (modelId === 'openrouter/auto') return 'openrouter-auto';
  return modelId.split('/').at(-1) || modelId;
}

function familyFromModelId(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.includes('opus')) return 'opus';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('haiku')) return 'haiku';
  if (id.includes('gpt')) return 'gpt';
  if (id.includes('gemini')) return 'gemini';
  if (id.includes('glm')) return 'glm';
  if (id.includes('minimax')) return 'minimax';
  return 'openrouter';
}

function releaseDateFromCreated(created?: number): string {
  if (!created) return '';
  return new Date(created * 1000).toISOString().slice(0, 10);
}

export class OpenRouterProvider implements Provider {
  readonly id = 'openrouter';
  readonly displayName = 'OpenRouter';

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    extendedThinking: true,
    thinkingModes: 'granular',
    maxContextWindow: 1_000_000,
    functionCalling: true,
    vision: true,
  };

  static readonly BASE_URL = 'https://openrouter.ai/api';
  static readonly MODELS_URL = 'https://openrouter.ai/api/v1/models/user';
  static readonly DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
  static readonly MAX_API_MODELS = 30;

  static readonly FALLBACK_MODELS: ModelInfo[] = [
    {
      id: 'openrouter/auto',
      name: 'OpenRouter Auto',
      alias: 'openrouter-auto',
      family: 'openrouter',
      provider: 'openrouter',
      contextWindow: 1_000_000,
      description: 'OpenRouter automatic model routing',
      releaseDate: '',
      available: true,
    },
    {
      id: 'anthropic/claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6 (OpenRouter)',
      alias: 'openrouter-sonnet',
      family: 'sonnet',
      provider: 'openrouter',
      contextWindow: 200_000,
      description: 'Claude Sonnet through OpenRouter',
      releaseDate: '',
      available: true,
    },
    {
      id: 'anthropic/claude-opus-4.7',
      name: 'Claude Opus 4.7 (OpenRouter)',
      alias: 'openrouter-opus',
      family: 'opus',
      provider: 'openrouter',
      contextWindow: 200_000,
      description: 'Claude Opus through OpenRouter',
      releaseDate: '',
      available: true,
    },
    {
      id: 'anthropic/claude-haiku-4.5',
      name: 'Claude Haiku 4.5 (OpenRouter)',
      alias: 'openrouter-haiku',
      family: 'haiku',
      provider: 'openrouter',
      contextWindow: 200_000,
      description: 'Claude Haiku through OpenRouter',
      releaseDate: '',
      available: true,
    },
  ];

  private modelCache: ModelInfo[] | null = null;
  private lastAuthError: string | undefined;
  private credentials: ProviderCredentials | null = null;

  clearModelCache(): void {
    this.modelCache = null;
  }

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  setCredentials(credentials: ProviderCredentials): void {
    this.credentials = credentials;
    this.clearModelCache();
  }

  getCredentials(): ProviderCredentials | null {
    return this.credentials;
  }

  isAvailable(): boolean {
    const apiKey = this.getApiKey();
    return !!apiKey && isProbablyOpenRouterKey(apiKey);
  }

  getApiKey(): string | undefined {
    const apiKey = this.env.OPENROUTER_API_KEY?.trim();
    return apiKey || (this.credentials?.type === 'api_key' ? this.credentials.apiKey : undefined);
  }

  private getAllowedModelIds(): Set<string> | null {
    const envConfigured = this.env.OPENROUTER_ALLOWED_MODELS ?? this.env.OPENROUTER_MODEL_ALLOWLIST;
    const configured = envConfigured ?? this.env.HYPERNEO_PROVIDER_MODEL_ALLOWLISTS;
    if (!configured?.trim()) return null;

    const ids = configured
      .split(/[\n,]/)
      .map((id) => id.trim())
      .filter(Boolean)
      .map((entry) => {
        if (envConfigured !== undefined) return entry;
        const [provider, ...rest] = entry.split(':');
        return provider === this.id && rest.length > 0 ? rest.join(':') : '';
      })
      .filter(Boolean);

    return ids.length > 0 ? new Set(ids) : null;
  }

  private getConfiguredAllowedModels(): ModelInfo[] {
    const allowedIds = this.getAllowedModelIds();
    if (!allowedIds) return [];

    return Array.from(allowedIds).map((id) => this.toModelInfo({ id }));
  }

  async getModels(): Promise<ModelInfo[]> {
    if (!this.isAvailable()) return [];
    if (this.modelCache) return this.modelCache;

    try {
      return await this.fetchModels();
    } catch (error) {
      if (error instanceof OpenRouterModelAuthError) return [];
      const fallback = this.getConfiguredAllowedModels();
      this.modelCache = fallback.length > 0 ? fallback : OpenRouterProvider.FALLBACK_MODELS;
      return this.modelCache;
    }
  }

  async listRemoteModels(options?: ListRemoteModelsOptions): Promise<ModelInfo[]> {
    if (!this.isAvailable()) return [];
    if (!options?.force && this.modelCache) return this.modelCache;
    return this.fetchModels();
  }

  ownsModel(modelId: string): boolean {
    return (
      modelId === 'openrouter/auto' ||
      /^[a-z0-9][a-z0-9._-]+\/[a-z0-9][a-z0-9._:-]+$/i.test(modelId)
    );
  }

  getModelForTier(tier: ModelTier): string | undefined {
    switch (tier) {
      case 'opus':
        return 'anthropic/claude-opus-4.7';
      case 'haiku':
        return 'anthropic/claude-haiku-4.5';
      case 'sonnet':
      case 'default':
        return OpenRouterProvider.DEFAULT_MODEL;
    }
  }

  buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    const apiKey = sessionConfig?.apiKey || this.getApiKey();
    if (!apiKey) {
      throw new Error('OpenRouter API key not configured. Set OPENROUTER_API_KEY.');
    }
    if (!isProbablyOpenRouterKey(apiKey)) {
      throw new Error(
        'OPENROUTER_API_KEY does not look like an OpenRouter key (expected sk-or-...).'
      );
    }

    const allowedIds = this.getAllowedModelIds();
    if (allowedIds && !allowedIds.has(modelId)) {
      throw new Error(
        `OpenRouter model '${modelId}' is not in the configured allowlist. Update it in Settings → Models → OpenRouter Model Allowlist.`
      );
    }

    const baseUrl = sessionConfig?.baseUrl || OpenRouterProvider.BASE_URL;
    const routingModelId = this.ownsModel(modelId) ? modelId : OpenRouterProvider.DEFAULT_MODEL;

    return {
      envVars: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_API_KEY: '',
        API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: routingModelId,
        ANTHROPIC_DEFAULT_SONNET_MODEL: routingModelId,
        ANTHROPIC_DEFAULT_OPUS_MODEL: routingModelId,
      },
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  translateModelIdForSdk(_modelId: string): string {
    return 'default';
  }

  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return {
        isAuthenticated: false,
        method: 'api_key',
        error: 'Set OPENROUTER_API_KEY to enable OpenRouter models.',
      };
    }
    if (!isProbablyOpenRouterKey(apiKey)) {
      return {
        isAuthenticated: false,
        method: 'api_key',
        error: 'OPENROUTER_API_KEY does not look like an OpenRouter key (expected sk-or-...).',
      };
    }

    return {
      isAuthenticated: this.lastAuthError === undefined,
      method: 'api_key',
      error: this.lastAuthError,
    };
  }

  private async fetchModels(): Promise<ModelInfo[]> {
    const response = await this.fetchImpl(OpenRouterProvider.MODELS_URL, {
      headers: {
        Authorization: `Bearer ${this.getApiKey()}`,
      },
    });

    if (response.status === 401 || response.status === 403) {
      this.lastAuthError =
        'OPENROUTER_API_KEY was rejected by OpenRouter. Check the key value and account credits.';
      throw new OpenRouterModelAuthError(this.lastAuthError);
    }
    if (!response.ok) {
      throw new Error(`OpenRouter model listing returned HTTP ${response.status}`);
    }

    const allowedIds = this.getAllowedModelIds();
    const body = (await response.json()) as OpenRouterModelsResponse;
    const models = (body.data ?? [])
      .filter((model) => typeof model.id === 'string' && model.id.length > 0)
      .filter(
        (model) =>
          allowedIds || !SYSTEM_MODEL_PREFIXES.some((prefix) => model.id.startsWith(prefix))
      )
      .filter((model) => !allowedIds || allowedIds.has(model.id))
      .map((model) => this.toModelInfo(model));
    this.modelCache = models;
    this.lastAuthError = undefined;
    return this.modelCache;
  }

  private toModelInfo(model: OpenRouterModel): ModelInfo {
    const contextWindow =
      model.context_length ??
      model.top_provider?.context_length ??
      this.capabilities.maxContextWindow;

    return {
      id: model.id,
      name: model.name || model.id,
      alias: providerModelAlias(model.id),
      family: familyFromModelId(model.id),
      provider: 'openrouter',
      contextWindow,
      description: model.description || model.name || model.id,
      releaseDate: releaseDateFromCreated(model.created),
      available: true,
      preferContextWindowMetadata: true,
    };
  }

  private static curateApiModels(models: ModelInfo[]): ModelInfo[] {
    const curated = models.filter((model) => {
      const id = model.id.toLowerCase();
      return CURATED_PROVIDER_PREFIXES.some((prefix) => id.startsWith(prefix));
    });

    const candidates = curated.length > 0 ? curated : models;
    return candidates.slice(0, OpenRouterProvider.MAX_API_MODELS);
  }
}

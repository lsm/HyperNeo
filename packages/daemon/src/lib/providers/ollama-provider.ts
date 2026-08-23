import type {
  ModelTier,
  Provider,
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderCredentials,
  ProviderSdkConfig,
  ProviderSessionConfig,
} from '@hyperneo/shared/provider';
import type { ModelInfo } from '@hyperneo/shared';
import {
  createOllamaAnthropicBridgeServer,
  type OllamaBridgeServer,
} from './ollama-bridge-server.js';
import { DEFAULT_PROBE_TIMEOUT_MS } from './shared/credential-probe.js';

type OllamaProviderKind = 'local' | 'cloud';

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    modified_at?: string;
    size?: number;
    digest?: string;
    details?: {
      family?: string;
      families?: string[];
      parameter_size?: string;
      quantization_level?: string;
    };
  }>;
}

interface OllamaProviderOptions {
  kind: OllamaProviderKind;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/$/, '');
}

function modelAlias(modelId: string): string {
  return modelId
    .replace(/:latest$/, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .toLowerCase();
}

function familyFromModel(modelId: string, family?: string): string {
  if (family) return family;
  const id = modelId.toLowerCase();
  if (id.includes('llama')) return 'llama';
  if (id.includes('qwen')) return 'qwen';
  if (id.includes('mistral')) return 'mistral';
  if (id.includes('gemma')) return 'gemma';
  if (id.includes('gpt-oss')) return 'gpt-oss';
  return 'ollama';
}

export class OllamaProvider implements Provider {
  readonly id: 'ollama' | 'ollama-cloud';
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    extendedThinking: false,
    thinkingModes: 'off',
    maxContextWindow: 128000,
    functionCalling: true,
    vision: false,
  };

  static readonly LOCAL_BASE_URL = 'http://localhost:11434';
  static readonly CLOUD_BASE_URL = 'https://ollama.com';
  static readonly DEFAULT_LOCAL_MODEL = 'llama3.2';
  static readonly DEFAULT_CLOUD_MODEL = 'gpt-oss:120b-cloud';

  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly kind: OllamaProviderKind;
  private modelCache: ModelInfo[] | null = null;
  private modelCacheAt = 0;
  private lastAuthError: string | undefined;
  private credentials: ProviderCredentials | null = null;
  private bridgeServers = new Map<string, OllamaBridgeServer>();

  constructor(options: OllamaProviderOptions) {
    this.kind = options.kind;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.id = options.kind === 'cloud' ? 'ollama-cloud' : 'ollama';
    this.displayName = options.kind === 'cloud' ? 'Ollama Cloud' : 'Ollama (Local)';
  }

  setCredentials(credentials: ProviderCredentials): void {
    this.credentials = credentials;
    this.clearModelCache();
  }

  getCredentials(): ProviderCredentials | null {
    return this.credentials;
  }

  async isAvailable(): Promise<boolean> {
    if (this.kind === 'cloud') return !!this.getApiKey();
    try {
      const response = await this.fetchImpl(`${this.getBaseUrl()}/api/tags`, {
        headers: this.getApiKey() ? { Authorization: `Bearer ${this.getApiKey()}` } : undefined,
        signal: AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) {
        this.lastAuthError = 'Ollama API key was rejected. Check OLLAMA_API_KEY.';
        return false;
      }
      if (response.ok) this.lastAuthError = undefined;
      return response.ok;
    } catch {
      return false;
    }
  }

  getApiKey(): string | undefined {
    const apiKey = this.kind === 'cloud' ? this.env.OLLAMA_CLOUD_API_KEY : this.env.OLLAMA_API_KEY;
    return (
      apiKey?.trim() || (this.credentials?.type === 'api_key' ? this.credentials.apiKey : undefined)
    );
  }

  getBaseUrl(): string {
    const envUrl =
      this.kind === 'cloud' ? this.env.OLLAMA_CLOUD_BASE_URL : this.env.OLLAMA_BASE_URL;
    return normalizeBaseUrl(
      envUrl ||
        (this.kind === 'cloud' ? OllamaProvider.CLOUD_BASE_URL : OllamaProvider.LOCAL_BASE_URL)
    );
  }

  clearModelCache(): void {
    this.modelCache = null;
    this.modelCacheAt = 0;
  }

  async getModels(): Promise<ModelInfo[]> {
    if (this.kind === 'cloud' && !this.getApiKey()) return [];
    if (this.modelCache && Date.now() - this.modelCacheAt < 5 * 60_000) return this.modelCache;
    try {
      const response = await this.fetchImpl(`${this.getBaseUrl()}/api/tags`, {
        headers: this.getApiKey() ? { Authorization: `Bearer ${this.getApiKey()}` } : undefined,
      });
      if (response.status === 401 || response.status === 403) {
        const keyName = this.kind === 'cloud' ? 'OLLAMA_CLOUD_API_KEY' : 'OLLAMA_API_KEY';
        this.lastAuthError = `Ollama API key was rejected. Check ${keyName}.`;
        return [];
      }
      if (!response.ok) return this.fallbackModels();
      const body = (await response.json()) as OllamaTagsResponse;
      const models = (body.models ?? [])
        .map((model) => this.toModelInfo(model))
        .filter((model): model is ModelInfo => model !== null);
      this.modelCache = models.length > 0 ? models : this.fallbackModels();
      this.modelCacheAt = Date.now();
      this.lastAuthError = undefined;
      return this.modelCache;
    } catch {
      return this.fallbackModels();
    }
  }

  ownsModel(modelId: string): boolean {
    const id = modelId.toLowerCase();
    if (id === 'ollama') return this.kind === 'local';
    if (id === 'ollama-cloud') return this.kind === 'cloud';
    const knownOllamaPrefixes = ['llama', 'qwen', 'mistral', 'gemma', 'phi', 'gpt-oss'];
    const isCloudModel =
      id.endsWith(':cloud') || (id.startsWith('gpt-oss:') && id.endsWith('-cloud'));
    const isLikelyCloudScaleModel =
      /^qwen[\w.-]*:[1-9]\d{2,}b$/.test(id) || /^gpt-oss:[1-9]\d{2,}b$/.test(id);
    if (this.kind === 'cloud') {
      return isCloudModel || isLikelyCloudScaleModel;
    }
    return (
      !isCloudModel &&
      !isLikelyCloudScaleModel &&
      (id.includes(':') || knownOllamaPrefixes.some((prefix) => id.startsWith(prefix)))
    );
  }

  getModelForTier(_tier: ModelTier): string | undefined {
    return this.kind === 'cloud'
      ? OllamaProvider.DEFAULT_CLOUD_MODEL
      : OllamaProvider.DEFAULT_LOCAL_MODEL;
  }

  buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    const apiKey = sessionConfig?.apiKey || this.getApiKey();
    if (this.kind === 'cloud' && !apiKey) {
      throw new Error('Ollama Cloud API key not configured. Set OLLAMA_CLOUD_API_KEY.');
    }
    const upstreamBaseUrl = normalizeBaseUrl(
      sessionConfig?.baseUrl ||
        this.getBaseUrl() ||
        (this.kind === 'cloud' ? OllamaProvider.CLOUD_BASE_URL : OllamaProvider.LOCAL_BASE_URL)
    );
    const bridge = this.getOrCreateBridge(upstreamBaseUrl, apiKey);
    const routingModelId =
      modelId && modelId !== 'default'
        ? modelId
        : this.kind === 'cloud'
          ? OllamaProvider.DEFAULT_CLOUD_MODEL
          : OllamaProvider.DEFAULT_LOCAL_MODEL;
    return {
      envVars: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridge.port}`,
        ANTHROPIC_AUTH_TOKEN: 'ollama-bridge',
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
    if (this.kind === 'cloud') {
      const apiKey = this.getApiKey();
      return {
        isAuthenticated: !!apiKey && this.lastAuthError === undefined,
        method: 'api_key',
        error: apiKey ? this.lastAuthError : 'Set OLLAMA_CLOUD_API_KEY to enable Ollama Cloud.',
      };
    }
    return {
      isAuthenticated: this.lastAuthError === undefined,
      method: 'api_key',
      error: this.lastAuthError,
    };
  }

  async shutdown(): Promise<void> {
    for (const bridge of this.bridgeServers.values()) bridge.stop();
    this.bridgeServers.clear();
  }

  private getOrCreateBridge(baseUrl: string, apiKey?: string): OllamaBridgeServer {
    const key = `${baseUrl}\u0000${apiKey ?? ''}`;
    const existingBridge = this.bridgeServers.get(key);
    if (existingBridge) return existingBridge;
    const bridge = createOllamaAnthropicBridgeServer({
      baseUrl,
      apiKey,
      fetchImpl: this.fetchImpl,
    });
    this.bridgeServers.set(key, bridge);
    return bridge;
  }

  private fallbackModels(): ModelInfo[] {
    const id =
      this.kind === 'cloud'
        ? OllamaProvider.DEFAULT_CLOUD_MODEL
        : OllamaProvider.DEFAULT_LOCAL_MODEL;
    return [
      {
        id,
        name: id,
        alias: this.kind === 'cloud' ? 'ollama-cloud' : 'ollama',
        family: familyFromModel(id),
        provider: this.id,
        contextWindow: this.capabilities.maxContextWindow,
        description:
          this.kind === 'cloud'
            ? 'Default Ollama Cloud model. Configure OLLAMA_CLOUD_API_KEY to load your model list.'
            : 'Default local Ollama model. Pull models with `ollama pull` to populate the list.',
        releaseDate: '',
        available: true,
      },
    ];
  }

  private toModelInfo(model: NonNullable<OllamaTagsResponse['models']>[number]): ModelInfo | null {
    const id = model.model || model.name;
    if (!id) return null;
    const details = model.details;
    const descriptor = [details?.parameter_size, details?.quantization_level]
      .filter(Boolean)
      .join(' ');
    return {
      id,
      name: model.name || id,
      alias: modelAlias(id),
      family: familyFromModel(id, details?.family),
      provider: this.id,
      contextWindow: this.capabilities.maxContextWindow,
      description: descriptor ? `Ollama ${descriptor}` : `Ollama model ${id}`,
      releaseDate: model.modified_at ? model.modified_at.slice(0, 10) : '',
      available: true,
    };
  }
}

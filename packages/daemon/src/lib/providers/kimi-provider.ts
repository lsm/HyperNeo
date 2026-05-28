/**
 * Kimi Provider - Moonshot AI（月之暗面）
 *
 * Kimi Code exposes a native Anthropic-compatible API at
 * https://api.kimi.com/coding/ — designed for coding agents.
 *
 * The API uses a single fixed model ID `kimi-for-coding` that automatically
 * maps to the latest Kimi flagship model, so no bridge server or protocol
 * translation is needed.
 *
 * API Documentation: https://www.kimi.com/code/docs/
 */

import type {
  Provider,
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderCredentials,
  ProviderSdkConfig,
  ProviderSessionConfig,
  ModelTier,
} from '@neokai/shared/provider';
import type { ModelInfo } from '@neokai/shared';

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export class KimiProvider implements Provider {
  readonly id = 'kimi';
  readonly displayName = 'Kimi (Moonshot AI)';

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    extendedThinking: true,
    thinkingModes: 'on',
    maxContextWindow: 262144,
    functionCalling: true,
    vision: false,
  };

  /** Anthropic-compatible base URL for Kimi Code. */
  static readonly BASE_URL = 'https://api.kimi.com/coding';
  /** OpenAI-compatible base URL for Kimi Code. */
  static readonly OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1';
  /**
   * Fixed model ID that automatically maps to the latest Kimi flagship model.
   * See https://www.kimi.com/code/docs/ — "统一使用模型 ID kimi-for-coding"
   */
  static readonly DEFAULT_MODEL = 'kimi-for-coding';

  static readonly MODELS: ModelInfo[] = [
    {
      id: 'kimi-for-coding',
      name: 'Kimi For Coding',
      alias: 'kimi',
      family: 'kimi',
      provider: 'kimi',
      contextWindow: 262144,
      description:
        'Kimi Code model (auto-upgrades to latest flagship). Fixed model ID for all requests.',
      releaseDate: '',
      available: true,
    },
  ];

  private readonly env: NodeJS.ProcessEnv;
  private credentials: ProviderCredentials | null = null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  setCredentials(credentials: ProviderCredentials): void {
    this.credentials = credentials;
  }

  getCredentials(): ProviderCredentials | null {
    return this.credentials;
  }

  isAvailable(): boolean {
    return !!this.getApiKey();
  }

  getApiKey(): string | undefined {
    if (this.credentials?.type === 'api_key') return this.credentials.apiKey;
    return this.env.KIMI_API_KEY?.trim() || this.env.MOONSHOT_API_KEY?.trim() || undefined;
  }

  async getModels(): Promise<ModelInfo[]> {
    return this.isAvailable() ? KimiProvider.MODELS : [];
  }

  ownsModel(modelId: string): boolean {
    const id = modelId.toLowerCase();
    return id === 'kimi' || id === 'kimi-for-coding' || id.startsWith('moonshot-');
  }

  getModelForTier(_tier: ModelTier): string | undefined {
    return KimiProvider.DEFAULT_MODEL;
  }

  buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    const apiKey = sessionConfig?.apiKey || this.getApiKey();
    if (!apiKey) {
      throw new Error('Kimi API key not configured. Set KIMI_API_KEY or MOONSHOT_API_KEY.');
    }

    const baseUrl = normalizeBaseUrl(sessionConfig?.baseUrl || KimiProvider.BASE_URL);
    // All Kimi Code requests use the fixed model ID
    const routingModelId = KimiProvider.DEFAULT_MODEL;

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

  getTitleGenerationModel(): string {
    return KimiProvider.DEFAULT_MODEL;
  }

  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    const apiKey = this.getApiKey();
    return {
      isAuthenticated: !!apiKey,
      method: 'api_key',
      error: apiKey ? undefined : 'Set KIMI_API_KEY or MOONSHOT_API_KEY to enable Kimi models.',
    };
  }

  async shutdown(): Promise<void> {
    // No resources to clean up — direct API connection.
  }
}

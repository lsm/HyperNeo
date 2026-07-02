/**
 * MiniMax Provider
 *
 * This provider uses MiniMax's Anthropic-compatible API endpoint.
 * Requires environment variable mapping to work with the Claude Agent SDK.
 *
 * API Documentation: https://platform.minimax.io/docs/guides/text-ai-coding-tools
 */

import type { ModelInfo } from '@hyperneo/shared';
import type {
  ModelTier,
  Provider,
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderCredentials,
  ProviderSdkConfig,
  ProviderSessionConfig,
} from '@hyperneo/shared/provider';
import { probeAnthropicCompatCredentials } from './shared/credential-probe.js';

/**
 * MiniMax provider implementation
 */
export class MinimaxProvider implements Provider {
  readonly id = 'minimax';
  readonly displayName = 'MiniMax';

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    extendedThinking: false,
    thinkingModes: 'off',
    maxContextWindow: 200000,
    functionCalling: true,
    vision: true,
  };

  /**
   * MiniMax API base URL (Anthropic-compatible endpoint)
   */
  static readonly BASE_URL = 'https://api.minimax.io/anthropic';

  /**
   * Static model definitions for MiniMax
   */
  static readonly MODELS: ModelInfo[] = [
    {
      id: 'MiniMax-M2.5',
      name: 'MiniMax-M2.5',
      alias: 'minimax',
      family: 'minimax',
      provider: 'minimax',
      contextWindow: 200000,
      description: 'MiniMax-M2.5 · Flagship Coding Model',
      releaseDate: '2026-01-01',
      available: true,
    },
    {
      id: 'MiniMax-M2.5-highspeed',
      name: 'MiniMax-M2.5-highspeed',
      alias: 'minimax-fast',
      family: 'minimax',
      provider: 'minimax',
      contextWindow: 200000,
      description: 'MiniMax-M2.5-highspeed · Fast Coding Model',
      releaseDate: '2026-01-01',
      available: true,
    },
    {
      id: 'MiniMax-M2.7',
      name: 'MiniMax-M2.7',
      alias: 'minimax-m27',
      family: 'minimax',
      provider: 'minimax',
      contextWindow: 200000,
      description: 'MiniMax-M2.7 · Flagship Coding Model',
      releaseDate: '2026-03-01',
      available: true,
    },
    {
      id: 'MiniMax-M2.7-highspeed',
      name: 'MiniMax-M2.7-highspeed',
      alias: 'minimax-m27-fast',
      family: 'minimax',
      provider: 'minimax',
      contextWindow: 200000,
      description: 'MiniMax-M2.7-highspeed · Fast Coding Model',
      releaseDate: '2026-03-01',
      available: true,
    },
  ];

  private credentials: ProviderCredentials | null = null;

  /**
   * Cached credential-probe result keyed by `{baseUrl}::{apiKey}` so repeated
   * `providers.test` calls don't re-probe within a short window.
   */
  private readonly probeCache = new Map<string, { at: number; result: Promise<void> }>();
  private static readonly PROBE_TTL_MS = 30_000;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  setCredentials(credentials: ProviderCredentials): void {
    this.credentials = credentials;
    this.probeCache.clear();
  }

  getCredentials(): ProviderCredentials | null {
    return this.credentials;
  }

  /**
   * Check if MiniMax is available
   * Requires MINIMAX_API_KEY
   */
  isAvailable(): boolean {
    return !!this.getApiKey();
  }

  /**
   * Get API key from environment
   */
  getApiKey(): string | undefined {
    return (
      this.env.MINIMAX_API_KEY ||
      (this.credentials?.type === 'api_key' ? this.credentials.apiKey : undefined)
    );
  }

  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    const apiKey = this.getApiKey();
    return {
      isAuthenticated: !!apiKey,
      method: 'api_key',
      error: apiKey ? undefined : 'Set MINIMAX_API_KEY to enable MiniMax models.',
    };
  }

  /**
   * Verify the configured MiniMax API key actually works against the upstream
   * Anthropic-compatible endpoint. Sends a minimal `/v1/messages` request
   * with `max_tokens: 1` so the probe never burns completion tokens.
   *
   * @throws {Error} when the key is rejected, the upstream is unreachable,
   *   or the request times out.
   */
  private async verifyCredentials(baseUrl: string, apiKey: string): Promise<void> {
    const cacheKey = `${baseUrl}::${apiKey}`;
    const cached = this.probeCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MinimaxProvider.PROBE_TTL_MS) {
      await cached.result;
      return;
    }
    const result = probeAnthropicCompatCredentials({
      baseUrl,
      apiKey,
      model: 'MiniMax-M2.7',
      providerName: 'MiniMax',
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

  /**
   * Get available models from MiniMax after verifying the API key works.
   */
  async getModels(): Promise<ModelInfo[]> {
    const apiKey = this.getApiKey();
    if (!apiKey) return [];
    await this.verifyCredentials(MinimaxProvider.BASE_URL, apiKey);
    return MinimaxProvider.MODELS;
  }

  /**
   * Check if a model ID belongs to MiniMax
   */
  ownsModel(modelId: string): boolean {
    return modelId.toLowerCase().startsWith('minimax-');
  }

  /**
   * Get model for a specific tier
   * All tiers use MiniMax-M2.7 (flagship model)
   */
  getModelForTier(_tier: ModelTier): string | undefined {
    return 'MiniMax-M2.7';
  }

  /**
   * Build SDK configuration for MiniMax
   * Routes ANTHROPIC_DEFAULT_*_MODEL to the selected model so the SDK uses
   * the model the user actually picked. Falls back to MiniMax-M2.7 for
   * unrecognised model IDs.
   */
  buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    const apiKey = sessionConfig?.apiKey || this.getApiKey();
    if (!apiKey) {
      throw new Error('MiniMax API key not configured');
    }

    const baseUrl = sessionConfig?.baseUrl || MinimaxProvider.BASE_URL;
    const routingModelId = this.ownsModel(modelId) ? modelId : 'MiniMax-M2.7';

    const envVars: Record<string, string> = {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_API_KEY: '',
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
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

  /**
   * Translate MiniMax model ID to SDK-compatible ID
   */
  translateModelIdForSdk(_modelId: string): string {
    return 'default';
  }

  /**
   * Get the title generation model for MiniMax
   */
  getTitleGenerationModel(): string {
    return 'MiniMax-M2.7';
  }

  async shutdown(): Promise<void> {}
}

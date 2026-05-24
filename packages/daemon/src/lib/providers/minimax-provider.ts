/**
 * MiniMax Provider
 *
 * This provider uses MiniMax's Anthropic-compatible API endpoint.
 * Requires environment variable mapping to work with the Claude Agent SDK.
 *
 * API Documentation: https://platform.minimax.io/docs/guides/text-ai-coding-tools
 */

import type {
  Provider,
  ProviderCapabilities,
  ProviderSdkConfig,
  ProviderSessionConfig,
  ModelTier,
} from '@neokai/shared/provider';
import type { ModelInfo } from '@neokai/shared';

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

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

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
    return this.env.MINIMAX_API_KEY;
  }

  /**
   * Get available models from MiniMax
   */
  async getModels(): Promise<ModelInfo[]> {
    return this.isAvailable() ? MinimaxProvider.MODELS : [];
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
}

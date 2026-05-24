/**
 * GLM Provider - Zhipu AI (智谱AI)
 *
 * This provider uses GLM's Anthropic-compatible API endpoint.
 * Requires environment variable mapping to work with the Claude Agent SDK.
 *
 * API Documentation: https://open.bigmodel.cn/dev/api
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
 * GLM provider implementation
 */
export class GlmProvider implements Provider {
  readonly id = 'glm';
  readonly displayName = 'GLM (智谱AI)';

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    extendedThinking: true,
    thinkingModes: 'granular',
    maxContextWindow: 200000,
    functionCalling: true,
    vision: true,
  };

  /**
   * GLM API base URL (Anthropic-compatible endpoint)
   */
  static readonly BASE_URL = 'https://open.bigmodel.cn/api/anthropic';

  /**
   * Static model definitions for GLM
   * These cannot be loaded dynamically from SDK
   */
  static readonly MODELS: ModelInfo[] = [
    {
      id: 'glm-5',
      name: 'GLM-5',
      // Intentionally shorter alias 'glm' (not 'glm-5') so users can type a short
      // provider-level shorthand. This asymmetry with other GLM model aliases is deliberate.
      alias: 'glm',
      family: 'glm',
      provider: 'glm',
      contextWindow: 200000,
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
      description: 'GLM-5.1 · Enhanced reasoning and instruction following',
      releaseDate: '2026-04-08',
      available: true,
    },
    {
      id: 'glm-5-turbo',
      name: 'GLM-5-Turbo',
      alias: 'glm-5-turbo',
      family: 'glm',
      provider: 'glm',
      contextWindow: 200000,
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
      description: 'GLM-4.7 · Zhipu AI high-performance model',
      releaseDate: '2025-12-01',
      available: true,
    },
  ];

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  /**
   * Check if GLM is available
   * Requires GLM_API_KEY or ZHIPU_API_KEY
   */
  isAvailable(): boolean {
    return !!this.getApiKey();
  }

  /**
   * Get API key from environment
   * Supports both GLM_API_KEY and ZHIPU_API_KEY
   */
  getApiKey(): string | undefined {
    return this.env.GLM_API_KEY || this.env.ZHIPU_API_KEY;
  }

  /**
   * Get available models from GLM
   * Returns static model list (GLM doesn't have dynamic model listing)
   */
  async getModels(): Promise<ModelInfo[]> {
    // Only return models if API key is available
    return this.isAvailable() ? GlmProvider.MODELS : [];
  }

  /**
   * Check if a model ID belongs to GLM
   * GLM models start with 'glm-'
   */
  ownsModel(modelId: string): boolean {
    return modelId === 'glm-5' || modelId.toLowerCase().startsWith('glm-');
  }

  /**
   * Get model for a specific tier
   * Maps Anthropic tiers to GLM models
   *
   * Always pins to glm-5-turbo regardless of which GLM model is active in the session.
   * This is an intentional policy: tier fallbacks and title generation use glm-5-turbo
   * (optimized for agent tasks), not the session model (which may be glm-5.1 or glm-4.7).
   */
  getModelForTier(_tier: ModelTier): string | undefined {
    return 'glm-5-turbo';
  }

  /**
   * Build SDK configuration for GLM
   *
   * GLM requires environment variable overrides to work with the SDK:
   * - ANTHROPIC_BASE_URL: Points to GLM's Anthropic-compatible endpoint
   * - ANTHROPIC_AUTH_TOKEN: GLM API key
   * - ANTHROPIC_DEFAULT_*_MODEL: Maps Anthropic tiers to GLM models
   * - API_TIMEOUT_MS: Extended timeout for GLM (50 minutes)
   * - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: Disable telemetry
   */
  buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    // Get API key: session override > global env
    const apiKey = sessionConfig?.apiKey || this.getApiKey();
    if (!apiKey) {
      throw new Error('GLM API key not configured');
    }

    // Get base URL: session override > default
    const baseUrl = sessionConfig?.baseUrl || GlmProvider.BASE_URL;

    // If modelId is not a GLM model ID (e.g. 'default'), fall back to glm-5-turbo.
    const routingModelId = modelId.toLowerCase().startsWith('glm-') ? modelId : 'glm-5-turbo';

    // Build environment variables
    const envVars: Record<string, string> = {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      // Extended timeout for GLM (50 minutes)
      API_TIMEOUT_MS: '3000000',
      // Disable non-essential traffic (telemetry, etc.)
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // Route all tiers to the selected model
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
   * Translate GLM model ID to SDK-compatible ID
   *
   * GLM model IDs (e.g. glm-5, glm-4.7) are not recognized by the SDK.
   * The SDK only knows Anthropic model IDs: default, opus, haiku.
   */
  translateModelIdForSdk(_modelId: string): string {
    return 'default';
  }

  /**
   * Get the title generation model for GLM
   * Uses glm-5
   */
  getTitleGenerationModel(): string {
    return 'glm-5-turbo';
  }
}

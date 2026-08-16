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
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderCredentials,
  ProviderSdkConfig,
  ProviderSessionConfig,
  ModelTier,
} from '@hyperneo/shared/provider';
import type { ModelInfo } from '@hyperneo/shared';
import { probeAnthropicCompatCredentials } from './shared/credential-probe.js';

/**
 * GLM provider implementation
 */
export class GlmProvider implements Provider {
  readonly id = 'glm';
  // GLM is the model family; the provider/company is Zhipu AI, branded Z.ai.
  readonly displayName = 'Z.ai';

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    extendedThinking: true,
    thinkingModes: 'granular',
    maxContextWindow: 1_000_000,
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
      // GLM model IDs are unknown to the Claude Agent SDK's hardcoded model table.
      // PP() falls back to 200k for unknown IDs, which happens to match the real
      // GLM context window for these models — but the context-fetcher must still
      // trust this metadata because the SDK may report the generic fallback as
      // the model's actual capacity, which can drift if the SDK's default changes.
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
      // The [1m] suffix is recognised by the SDK's PP() helper, so it returns
      // 1M for this ID. Combined with CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000
      // (set in buildSdkConfig), the SDK auto-compact window becomes
      // min(1M, 1M) = 1M, matching the real GLM-5.2 context window. Compaction
      // fires at ~987k (window - 13k SDK reserve).
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
      // Same [1m] routing as glm-5.2[1m] — see that entry's comment.
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

  /**
   * Lookup map for the real context window of each GLM model ID, including
   * the [1m] suffix variant used for SDK routing. Used by buildSdkConfig()
   * to set CLAUDE_CODE_AUTO_COMPACT_WINDOW so the SDK's auto-compact threshold
   * matches the provider's real capacity instead of its hardcoded 200k fallback.
   */
  private static readonly CONTEXT_WINDOW_BY_MODEL_ID: Record<string, number> = Object.fromEntries(
    GlmProvider.MODELS.map((m) => [m.id, m.contextWindow])
  );

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
    return (
      this.env.GLM_API_KEY ||
      this.env.ZHIPU_API_KEY ||
      (this.credentials?.type === 'api_key' ? this.credentials.apiKey : undefined)
    );
  }

  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    const apiKey = this.getApiKey();
    return {
      isAuthenticated: !!apiKey,
      method: 'api_key',
      error: apiKey ? undefined : 'Set GLM_API_KEY or ZHIPU_API_KEY to enable GLM models.',
    };
  }

  /**
   * Verify the configured GLM API key actually works against the upstream
   * Anthropic-compatible endpoint. Sends a minimal `/v1/messages` request
   * with `max_tokens: 1` so the probe never burns completion tokens.
   *
   * @throws {Error} when the key is rejected, the upstream is unreachable,
   *   or the request times out.
   */
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

  /**
   * Get available models from GLM
   * Returns static model list after verifying the API key works upstream.
   */
  async getModels(): Promise<ModelInfo[]> {
    const apiKey = this.getApiKey();
    if (!apiKey) return [];
    await this.verifyCredentials(GlmProvider.BASE_URL, apiKey);
    return GlmProvider.MODELS;
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
      throw new Error('Z.ai API key not configured');
    }

    // Get base URL: session override > default
    const baseUrl = sessionConfig?.baseUrl || GlmProvider.BASE_URL;

    // Normalise case so "GLM-5.2" / "GLM-5" route the same as their lowercase
    // forms. Without this, an uppercase modelId bypasses the glm-5.2 → [1m]
    // shortcut, falls through to verbatim routing, misses the context-window
    // lookup, and silently falls back to 200k.
    const normalisedModelId = modelId.toLowerCase();

    // If modelId is not a GLM model ID (e.g. 'default'), fall back to glm-5-turbo.
    // Strip ALL trailing [1m] suffixes (e.g. 'glm-5.2[1m][1m]' → 'glm-5.2')
    // to prevent double-suffix regressions from accumulating.
    const baseModelId = normalisedModelId.replace(/(\[1m\])+$/, '');
    const ONE_M_MODEL_IDS = new Set(['glm-5.2', 'glm-5.3']);
    const routingModelId = ONE_M_MODEL_IDS.has(baseModelId)
      ? `${baseModelId}[1m]`
      : baseModelId.startsWith('glm-')
        ? baseModelId
        : 'glm-5-turbo';

    // Resolve the real context window for the routing model ID so we can tell
    // the SDK the correct auto-compact threshold. Without this, the SDK uses
    // PP(model) which returns 200k for unknown model IDs — wrong for glm-5.2[1m]
    // (1M). Belt-and-suspenders with Options.settings.autoCompactWindow set by
    // buildProviderSettings(): env var has highest priority in the SDK's
    // resolution chain.
    const contextWindow = GlmProvider.CONTEXT_WINDOW_BY_MODEL_ID[routingModelId] ?? 200_000;

    // Build environment variables
    const envVars: Record<string, string> = {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      // Extended timeout for GLM (50 minutes)
      API_TIMEOUT_MS: '3000000',
      // Disable non-essential traffic (telemetry, etc.)
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // Tell the SDK the real GLM context window so auto-compact fires at the
      // correct threshold instead of the SDK's hardcoded 200k fallback for
      // unknown models. For glm-5.2[1m], this is 1M; for the 200k models, this
      // matches the SDK fallback but pins it explicitly so future SDK defaults
      // can't silently change compaction behaviour.
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindow),
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

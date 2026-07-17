/**
 * Kimi Provider - Moonshot AI（月之暗面）
 *
 * Kimi Code exposes an Anthropic-compatible API with fixed model IDs that the
 * backend auto-upgrades to the latest model:
 *
 * - `kimi-k3`                 → Kimi K3
 * - `kimi-k2.7-code`          → Kimi K2.7 Code
 * - `kimi-k2.7-code-highspeed`→ Kimi K2.7 Code Highspeed
 * - `kimi-for-coding`         → legacy alias, still routes to K2.7 Code
 *
 * Two region endpoint families are tracked:
 *
 * - Kimi Code (Anthropic-compatible, used by default):
 *   - China:  `https://api.moonshot.cn/anthropic`
 *   - Global: `https://api.moonshot.ai/anthropic`
 * - Moonshot platform (OpenAI-compatible, selectable via `baseUrl` /
 *   `KIMI_BASE_URL` override):
 *   - China:  `https://api.moonshot.cn/v1`
 *   - Global: `https://api.moonshot.ai/v1`
 *
 * The existing Anthropic-messages pass-through bridge is sufficient for the
 * Kimi Code endpoints because they speak the Anthropic Messages protocol. The
 * Moonshot `/v1` endpoints are OpenAI-compatible and would require an
 * OpenAI-compatible bridge or protocol toggle; they are exposed here as
 * overrides for advanced users who want to use the native platform endpoints.
 *
 * Region is read from `sessionConfig.region` (string `'china' | 'global'`)
 * or `KIMI_REGION`, falling back to the provider-level default and then
 * `'china'` for backward compatibility. `sessionConfig.baseUrl` and
 * `KIMI_BASE_URL` always win when set.
 *
 * API Documentation:
 * - https://platform.kimi.ai/docs/guide/agent-support
 * - https://platform.kimi.com/docs/guide/kimi-k3-quickstart
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

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Region identifiers supported by the Kimi provider.
 *
 * - `china`  — domestic endpoint at `api.moonshot.cn`.
 * - `global` — international endpoint at `api.moonshot.ai`.
 */
export type KimiRegion = 'china' | 'global';

const VALID_REGIONS: ReadonlySet<KimiRegion> = new Set<KimiRegion>(['china', 'global']);

/**
 * Per-region endpoint table for the Kimi provider.
 *
 * Anthropic-compatible base URLs are passed directly to the Claude Agent SDK.
 * The OpenAI-compatible endpoints are exposed for direct callers that prefer
 * the OpenAI schema.
 */
export const KIMI_REGION_ENDPOINTS: Record<
  KimiRegion,
  { anthropicBaseUrl: string; openAiBaseUrl: string; modelId: string }
> = {
  china: {
    anthropicBaseUrl: 'https://api.moonshot.cn/anthropic',
    openAiBaseUrl: 'https://api.moonshot.cn/v1',
    modelId: 'kimi-k2.7-code',
  },
  global: {
    anthropicBaseUrl: 'https://api.moonshot.ai/anthropic',
    openAiBaseUrl: 'https://api.moonshot.ai/v1',
    modelId: 'kimi-k2.7-code',
  },
};

/**
 * Coerce an unknown region value into a valid `KimiRegion`, defaulting to
 * `'china'` for anything missing or unrecognised. This is the single source
 * of truth for backward compatibility — existing credentials without a region
 * continue to route to the China endpoint.
 *
 * Matching is case-insensitive so hand-crafted payloads using `'CHINA'` or
 * `'Global'` normalise correctly. The UI uses a `<select>` so it always
 * emits a canonical lowercase value, but defensive normalisation here keeps
 * the API tolerant of direct RPC callers.
 */
export function resolveKimiRegion(region: unknown): KimiRegion {
  if (typeof region === 'string') {
    const normalised = region.toLowerCase() as KimiRegion;
    if (VALID_REGIONS.has(normalised)) {
      return normalised;
    }
  }
  return 'china';
}

export class KimiProvider implements Provider {
  readonly id = 'kimi';
  readonly displayName = 'Kimi (Moonshot AI)';

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    extendedThinking: true,
    thinkingModes: 'on',
    maxContextWindow: 1_048_576,
    functionCalling: true,
    vision: false,
  };

  /**
   * Anthropic-compatible base URL for the default (China) region. Retained for
   * backward compatibility — new code should use `getBaseUrlForRegion()`.
   */
  static readonly BASE_URL = KIMI_REGION_ENDPOINTS.china.anthropicBaseUrl;
  /**
   * OpenAI-compatible base URL for the default (China) region. Retained for
   * backward compatibility — new code should use `getOpenAiBaseUrlForRegion()`.
   */
  static readonly OPENAI_BASE_URL = KIMI_REGION_ENDPOINTS.china.openAiBaseUrl;
  /** Default region model ID retained for backward compatibility. */
  static readonly DEFAULT_MODEL = KIMI_REGION_ENDPOINTS.china.modelId;
  static readonly GLOBAL_MODEL = KIMI_REGION_ENDPOINTS.global.modelId;

  static readonly MODELS: ModelInfo[] = [
    {
      id: 'kimi-k3',
      name: 'Kimi K3',
      alias: 'k3',
      family: 'kimi',
      provider: 'kimi',
      contextWindow: 1_048_576,
      providerAliases: ['k3', 'kimi-k3', 'K3', 'Kimi-K3'],
      providerAliasPrefixes: ['moonshot-k3'],
      preferContextWindowMetadata: true,
      description: 'Kimi K3 · 1M context window reasoning model',
      releaseDate: '',
      available: true,
    },
    {
      id: 'kimi-k2.7-code-highspeed',
      name: 'Kimi K2.7 Code Highspeed',
      alias: 'kimi-k2.7-code-highspeed',
      family: 'kimi',
      provider: 'kimi',
      contextWindow: 262_144,
      providerAliases: ['kimi-k2.7-code-highspeed', 'kimi-for-coding-highspeed'],
      preferContextWindowMetadata: true,
      description: 'Kimi K2.7 Code Highspeed · fast coding model',
      releaseDate: '',
      available: true,
    },
    {
      id: 'kimi-for-coding',
      name: 'Kimi K2.7',
      alias: 'kimi',
      family: 'kimi',
      provider: 'kimi',
      contextWindow: 262_144,
      // Keep region-specific and provider-accepted aliases resolving to the
      // canonical Kimi entry so saved sessions retain context metadata.
      providerAliases: ['KIMI', 'Kimi', 'kimi-k2.7-code', 'Kimi-K2.7-Code'],
      providerAliasPrefixes: ['moonshot-'],
      preferContextWindowMetadata: true,
      description: 'Kimi Code model from Moonshot Claude Code integration docs.',
      releaseDate: '',
      available: true,
    },
  ];

  private readonly env: NodeJS.ProcessEnv;
  private credentials: ProviderCredentials | null = null;
  /**
   * Provider-level default region, populated from the providers table
   * `configJson` blob by `syncProviderToRegistry`. Falls back to `'china'`
   * when unset (e.g., env-var-only setups, legacy credentials, or unit tests
   * that construct the provider directly).
   */
  private defaultRegion: KimiRegion = 'china';

  /**
   * Cached credential-probe result keyed by `{baseUrl}::{modelId}::{apiKey}` so
   * repeated `providers.test` / model-picker loads don't re-probe the same
   * upstream within a short window. Cleared on `setCredentials()`.
   */
  private readonly probeCache = new Map<string, { at: number; result: Promise<void> }>();
  private static readonly PROBE_TTL_MS = 30_000;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    _legacyBridgeFactory?: unknown,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.env = env;
  }

  setCredentials(credentials: ProviderCredentials): void {
    this.credentials = credentials;
    this.probeCache.clear();
  }

  getCredentials(): ProviderCredentials | null {
    return this.credentials;
  }

  /**
   * Set the provider-level default region from the providers table
   * `configJson` blob. Called by `syncProviderToRegistry` after reading the
   * persisted record. Per-session `sessionConfig.region` overrides still win.
   */
  setDefaultRegion(region: KimiRegion): void {
    this.defaultRegion = region;
  }

  /**
   * Get the provider-level default region (set from the providers table).
   * Mainly useful for diagnostics and tests.
   */
  getDefaultRegion(): KimiRegion {
    return this.defaultRegion;
  }

  /**
   * Resolve the Anthropic-compatible base URL for the given region, ignoring
   * any per-session `baseUrl` override. Returns the China endpoint by default.
   */
  static getBaseUrlForRegion(region: KimiRegion = 'china'): string {
    return KIMI_REGION_ENDPOINTS[region].anthropicBaseUrl;
  }

  /**
   * Resolve the OpenAI-compatible base URL for the given region. Returns the
   * China endpoint by default.
   */
  static getOpenAiBaseUrlForRegion(region: KimiRegion = 'china'): string {
    return KIMI_REGION_ENDPOINTS[region].openAiBaseUrl;
  }

  static getModelIdForRegion(region: KimiRegion = 'china'): string {
    return KIMI_REGION_ENDPOINTS[region].modelId;
  }

  /**
   * Detect whether a model ID resolves to the Kimi K3 catalogue entry.
   *
   * K3 accepts the `thinking` field only when it is omitted entirely; it does
   * not support `thinking.type` in either `enabled` or `disabled` form. This
   * helper lets one-turn helpers (title generation, workflow selection,
   * evolution analysis) skip the `thinking: { type: 'disabled' }` payload that
   * is normally safe for other models.
   */
  static isKimiK3Model(modelId: string): boolean {
    const id = modelId.toLowerCase();
    return id === 'k3' || id === 'kimi-k3' || id.startsWith('moonshot-k3');
  }

  /**
   * Resolve the thinking option for short one-turn helpers.
   *
   * Most models accept `thinking: { type: 'disabled' }` for title-generation
   * style calls, but Kimi K3 requires the field to be omitted entirely.
   */
  static resolveKimiTitleThinkingConfig(modelId: string): { type: 'disabled' } | undefined {
    return KimiProvider.isKimiK3Model(modelId) ? undefined : { type: 'disabled' };
  }

  /**
   * Infer the Kimi region from a known base URL. This lets env-only overrides
   * like `KIMI_BASE_URL=https://api.moonshot.ai/anthropic` pick the correct
   * region-specific model ID without also requiring `KIMI_REGION`.
   *
   * Returns `undefined` for unknown/custom URLs so callers fall back to the
   * explicit region or provider default.
   */
  static resolveRegionFromBaseUrl(baseUrl: string): KimiRegion | undefined {
    const normalized = normalizeBaseUrl(baseUrl).toLowerCase();
    if (
      normalized === KIMI_REGION_ENDPOINTS.global.anthropicBaseUrl.toLowerCase() ||
      normalized === KIMI_REGION_ENDPOINTS.global.openAiBaseUrl.toLowerCase()
    ) {
      return 'global';
    }
    if (
      normalized === KIMI_REGION_ENDPOINTS.china.anthropicBaseUrl.toLowerCase() ||
      normalized === KIMI_REGION_ENDPOINTS.china.openAiBaseUrl.toLowerCase()
    ) {
      return 'china';
    }
    return undefined;
  }

  isAvailable(): boolean {
    return !!this.getApiKey();
  }

  getApiKey(): string | undefined {
    return (
      this.env.KIMI_API_KEY?.trim() ||
      this.env.MOONSHOT_API_KEY?.trim() ||
      (this.credentials?.type === 'api_key' ? this.credentials.apiKey : undefined)
    );
  }

  /**
   * Verify the configured Kimi API key actually works against the upstream
   * Anthropic-compatible endpoint. Sends a minimal `/v1/messages` request
   * with `max_tokens: 1` so the probe never burns completion tokens.
   *
   * Results are cached per `{baseUrl}::{apiKey}` for `PROBE_TTL_MS` so
   * repeated health checks (e.g. `providers.healthCheck` polling) don't
   * re-probe within the window. A failed probe is NOT cached so transient
   * failures self-heal on the next call.
   *
   * @throws {Error} when the key is rejected, the upstream is unreachable,
   *   or the request times out.
   */
  private async verifyCredentials(
    baseUrl: string,
    apiKey: string,
    modelId: string,
    thinking?: { type: 'enabled'; budget_tokens: number }
  ): Promise<void> {
    const cacheKey = `${baseUrl}::${modelId}::${apiKey}`;
    const cached = this.probeCache.get(cacheKey);
    if (cached && Date.now() - cached.at < KimiProvider.PROBE_TTL_MS) {
      // Re-throw the cached failure or resolve the cached success.
      await cached.result;
      return;
    }
    const result = probeAnthropicCompatCredentials({
      baseUrl,
      apiKey,
      model: modelId,
      providerName: 'Kimi',
      fetchImpl: this.fetchImpl,
      thinking,
    })
      .then(() => undefined)
      .catch((err) => {
        // Don't cache failures — let the next call retry.
        this.probeCache.delete(cacheKey);
        throw err;
      });
    this.probeCache.set(cacheKey, { at: Date.now(), result });
    await result;
  }

  async getModels(): Promise<ModelInfo[]> {
    const apiKey = this.getApiKey();
    if (!apiKey) return [];
    const region = resolveKimiRegion(this.env.KIMI_REGION ?? this.defaultRegion);
    const regionBaseUrl = KimiProvider.getBaseUrlForRegion(region);
    const baseUrl = normalizeBaseUrl(this.env.KIMI_BASE_URL || regionBaseUrl);
    // Probe with the K2.7 model, which is available to all Kimi members. K2.7
    // requires thinking to be enabled, so include a minimal thinking payload.
    const probeModelId = KimiProvider.getModelIdForRegion(region);
    await this.verifyCredentials(baseUrl, apiKey, probeModelId, {
      type: 'enabled',
      budget_tokens: 16_000,
    });
    return KimiProvider.MODELS;
  }

  ownsModel(modelId: string): boolean {
    const id = modelId.toLowerCase();
    return (
      id === 'kimi' ||
      id === 'k3' ||
      id === 'kimi-k3' ||
      id === 'kimi-for-coding' ||
      id === 'kimi-k2.7-code' ||
      id === 'kimi-k2.7-code-highspeed' ||
      id === 'kimi-for-coding-highspeed' ||
      id.startsWith('moonshot-')
    );
  }

  getModelForTier(_tier: ModelTier): string | undefined {
    return KimiProvider.DEFAULT_MODEL;
  }

  /**
   * Resolve the user-visible/canonical model ID from an alias or fixed ID.
   * Keeps saved session IDs stable by mapping every accepted spelling to one
   * of the three catalogue entries.
   */
  private static canonicalizeModelId(modelId: string): string {
    const id = modelId.toLowerCase();
    if (id === 'k3' || id === 'kimi-k3' || id.startsWith('moonshot-k3')) return 'kimi-k3';
    if (id === 'kimi-k2.7-code-highspeed' || id === 'kimi-for-coding-highspeed')
      return 'kimi-k2.7-code-highspeed';
    if (id === 'kimi-k2.7-code') return 'kimi-k2.7-code';
    if (id === 'kimi' || id === 'kimi-for-coding' || id.startsWith('moonshot-'))
      return 'kimi-for-coding';
    return modelId;
  }

  /**
   * Map the selected (or canonical) model ID to the upstream Kimi Code fixed ID
   * used on the Anthropic-compatible endpoints.
   *
   * The K2.7 catalogue entry is region-sensitive: the global endpoint advertises
   * `kimi-k2.7-code`, while the China endpoint advertises `kimi-for-coding`.
   */
  private static resolveUpstreamModelId(modelId: string, region: KimiRegion = 'china'): string {
    const id = modelId.toLowerCase();
    if (id === 'k3' || id === 'kimi-k3' || id.startsWith('moonshot-k3')) return 'kimi-k3';
    if (id === 'kimi-k2.7-code-highspeed' || id === 'kimi-for-coding-highspeed')
      return 'kimi-k2.7-code-highspeed';
    if (
      id === 'kimi-k2.7-code' ||
      id === 'kimi' ||
      id === 'kimi-for-coding' ||
      id.startsWith('moonshot-')
    )
      return KimiProvider.getModelIdForRegion(region);
    return KimiProvider.getModelIdForRegion(region);
  }

  /**
   * Look up the real context window for a selected model. The SDK's internal
   * resolver does not know non-Anthropic IDs, so we pin the value explicitly
   * via `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.
   */
  private static resolveContextWindow(modelId: string): number {
    const canonical = KimiProvider.canonicalizeModelId(modelId);
    if (canonical === 'kimi-k3') return 1_048_576;
    return 262_144;
  }

  buildSdkConfig(_modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    const apiKey = sessionConfig?.apiKey || this.getApiKey();
    if (!apiKey) {
      throw new Error('Kimi API key not configured. Set KIMI_API_KEY or MOONSHOT_API_KEY.');
    }

    // Resolve base URL: explicit sessionConfig.baseUrl wins, then KIMI_BASE_URL,
    // then the region endpoint. Per-session region overrides the provider-level
    // default region (set from the providers table configJson); both default to
    // 'china' for backward compatibility with pre-region credentials.
    //
    // When no explicit region is given, infer it from known Kimi base URLs so
    // env-only overrides like `KIMI_BASE_URL=https://api.moonshot.ai/anthropic`
    // pick the matching region model ID.
    const explicitRegion = sessionConfig?.region ?? this.env.KIMI_REGION;
    const regionBaseUrl = KimiProvider.getBaseUrlForRegion(
      explicitRegion ? resolveKimiRegion(explicitRegion) : this.defaultRegion
    );
    const baseUrl = normalizeBaseUrl(
      sessionConfig?.baseUrl || this.env.KIMI_BASE_URL || regionBaseUrl
    );

    // The Moonshot `/v1` endpoints are OpenAI-compatible, not Anthropic-compatible.
    // Feeding them into ANTHROPIC_BASE_URL would cause the Claude SDK to send
    // Anthropic Messages requests to an OpenAI base URL and fail at request time.
    if (baseUrl.endsWith('/v1')) {
      throw new Error(
        `Kimi base URL ${baseUrl} appears to be a Moonshot OpenAI-compatible /v1 endpoint. ` +
          'Use the Kimi Code Anthropic-compatible endpoint (e.g. https://api.moonshot.ai/anthropic) instead.'
      );
    }

    const region = explicitRegion
      ? resolveKimiRegion(explicitRegion)
      : (KimiProvider.resolveRegionFromBaseUrl(baseUrl) ?? this.defaultRegion);
    const contextWindow = KimiProvider.resolveContextWindow(_modelId);
    const routingModelId = KimiProvider.resolveUpstreamModelId(_modelId, region);

    return {
      envVars: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_MODEL: routingModelId,
        ANTHROPIC_DEFAULT_OPUS_MODEL: routingModelId,
        ANTHROPIC_DEFAULT_SONNET_MODEL: routingModelId,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: routingModelId,
        CLAUDE_CODE_SUBAGENT_MODEL: routingModelId,
        ENABLE_TOOL_SEARCH: 'false',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindow),
        API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  translateModelIdForSdk(modelId: string): string {
    // Return the canonical model ID so user-selected model is used.
    // Returning 'default' allows ~/.claude/settings.json overrides
    // (ANTHROPIC_DEFAULT_SONNET_MODEL) to incorrectly redirect to other providers.
    return KimiProvider.canonicalizeModelId(modelId);
  }

  /**
   * Use the K3 model for title generation: it does not require an explicit
   * thinking payload, unlike the K2.7 models. The title path always disables
   * thinking, so picking a no-thinking model avoids upstream rejections.
   */
  getTitleGenerationModel(): string {
    return 'kimi-k3';
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
    // Kimi uses Moonshot's native Anthropic-compatible endpoint directly.
  }
}

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
    // Default China endpoint remains the legacy Kimi Code host so existing
    // credentials and migration records ({ region: 'china' }) keep working.
    // The newer Moonshot Open Platform China host can be reached via an
    // explicit base URL override (KIMI_BASE_URL / sessionConfig.baseUrl).
    anthropicBaseUrl: 'https://api.kimi.com/coding',
    openAiBaseUrl: 'https://api.kimi.com/coding/v1',
    modelId: 'kimi-for-coding',
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
      providerAliases: ['k3', 'kimi-k3', 'K3', 'Kimi-K3', 'k3[1m]', 'kimi-k3[1m]'],
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
   * Strip the optional `[1m]` context-window suffix that the SDK and Kimi docs
   * use to mark 1M-context models. Normalising first lets documented IDs such
   * as `kimi-k3[1m]` or `k3[1m]` flow through the same alias/prefix checks as
   * the plain IDs.
   */
  private static normalizeKimiModelId(modelId: string): string {
    return modelId
      .replace(/\[1m\]$/i, '')
      .trim()
      .toLowerCase();
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
    const id = KimiProvider.normalizeKimiModelId(modelId);
    return id === 'k3' || id === 'kimi-k3' || id.startsWith('moonshot-k3');
  }

  /**
   * Detect whether a model ID resolves to a Kimi K2.7 catalogue entry or alias.
   *
   * K2.7 models require explicit thinking to be enabled; they do not accept
   * `thinking: { type: 'disabled' }`.
   */
  static isKimiK2Point7Model(modelId: string): boolean {
    const id = KimiProvider.normalizeKimiModelId(modelId);
    if (KimiProvider.isKimiK3Model(modelId)) return false;
    return (
      id === 'kimi' ||
      id === 'kimi-for-coding' ||
      id === 'kimi-k2.7-code' ||
      id === 'kimi-k2.7-code-highspeed' ||
      id === 'kimi-for-coding-highspeed' ||
      id.startsWith('moonshot-')
    );
  }

  /**
   * Resolve the thinking option for short one-turn helpers.
   *
   * Kimi K3 does not accept a `thinking` field in any form; it must be omitted.
   * Kimi K2.7 models require thinking to be explicitly enabled. Every other
   * model can safely accept `thinking: { type: 'disabled' }`.
   */
  static resolveKimiTitleThinkingConfig(
    modelId: string
  ): { type: 'enabled'; budgetTokens: 16000 } | { type: 'disabled' } | undefined {
    if (KimiProvider.isKimiK3Model(modelId)) return undefined;
    if (KimiProvider.isKimiK2Point7Model(modelId)) {
      return { type: 'enabled', budgetTokens: 16_000 };
    }
    return { type: 'disabled' };
  }

  /**
   * Infer the Kimi region from a known base URL. This lets env-only overrides
   * like `KIMI_BASE_URL=https://api.moonshot.ai/anthropic` pick the correct
   * region-specific model ID without also requiring `KIMI_REGION`.
   *
   * Recognises both the legacy `api.kimi.com/coding` China endpoints and the
   * modern Moonshot Open Platform endpoints (`api.moonshot.cn/*` and
   * `api.moonshot.ai/*`).
   *
   * Returns `undefined` for unknown/custom URLs so callers fall back to the
   * explicit region or provider default.
   */
  static resolveRegionFromBaseUrl(baseUrl: string): KimiRegion | undefined {
    const normalized = normalizeBaseUrl(baseUrl).toLowerCase();
    try {
      const host = new URL(normalized).host;
      if (host === 'api.moonshot.ai') {
        return 'global';
      }
      if (host === 'api.moonshot.cn' || host === 'api.kimi.com') {
        return 'china';
      }
    } catch {
      // Ignore malformed URLs and fall through to exact matching.
    }
    // Preserve exact matches for contexts where URL parsing is unavailable or
    // the value is not a well-formed URL.
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

  /**
   * Detect whether a base URL belongs to the legacy Kimi Code China endpoint
   * (`https://api.kimi.com/coding`). That endpoint advertises its own model ID
   * family (`k3`, `kimi-for-coding`, `kimi-for-coding-highspeed`) and must not
   * receive the modern Moonshot Open Platform IDs.
   */
  private static isLegacyKimiCodeEndpoint(baseUrl: string): boolean {
    const normalized = normalizeBaseUrl(baseUrl).toLowerCase();
    try {
      const url = new URL(normalized);
      return url.host === 'api.kimi.com' && url.pathname.startsWith('/coding');
    } catch {
      return false;
    }
  }

  /**
   * Detect whether a base URL belongs to the modern Moonshot Open Platform.
   * Both `api.moonshot.ai` (global) and `api.moonshot.cn` (China) advertise the
   * Open Platform model ID family (`kimi-k3`, `kimi-k2.7-code`,
   * `kimi-k2.7-code-highspeed`).
   */
  private static isModernMoonshotOpenPlatformEndpoint(baseUrl: string): boolean {
    const normalized = normalizeBaseUrl(baseUrl).toLowerCase();
    try {
      const host = new URL(normalized).host;
      return host === 'api.moonshot.ai' || host === 'api.moonshot.cn';
    } catch {
      return false;
    }
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
    // Region precedence mirrors `buildSdkConfig`: explicit `KIMI_REGION` wins,
    // otherwise infer from a known `KIMI_BASE_URL`, then fall back to the
    // provider-level default. This lets env-only global setups such as
    // `KIMI_BASE_URL=https://api.moonshot.ai/anthropic` probe the right model.
    const explicitRegion = this.env.KIMI_REGION;
    const regionBaseUrl = KimiProvider.getBaseUrlForRegion(
      explicitRegion ? resolveKimiRegion(explicitRegion) : this.defaultRegion
    );
    const baseUrl = normalizeBaseUrl(this.env.KIMI_BASE_URL || regionBaseUrl);
    const region = explicitRegion
      ? resolveKimiRegion(explicitRegion)
      : (KimiProvider.resolveRegionFromBaseUrl(baseUrl) ?? this.defaultRegion);
    // Probe with a K2.7 model that exists on the target endpoint family. The
    // legacy China endpoint advertises `kimi-for-coding`, while the modern
    // Moonshot Open Platform endpoints advertise `kimi-k2.7-code`. K2.7 requires
    // thinking to be explicitly enabled, so include a minimal enabled thinking
    // payload; max_tokens is set to budget_tokens + 1 by the probe.
    const probeModelId = KimiProvider.resolveUpstreamModelId(
      KimiProvider.getModelIdForRegion(region),
      baseUrl,
      region
    );
    await this.verifyCredentials(baseUrl, apiKey, probeModelId, {
      type: 'enabled',
      budget_tokens: 16_000,
    });
    return KimiProvider.MODELS;
  }

  ownsModel(modelId: string): boolean {
    const id = KimiProvider.normalizeKimiModelId(modelId);
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
    const id = KimiProvider.normalizeKimiModelId(modelId);
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
   * The mapping is endpoint-family aware:
   * - The legacy China endpoint (`https://api.kimi.com/coding`) advertises
   *   `k3`, `kimi-for-coding`, and `kimi-for-coding-highspeed`.
   * - The modern Moonshot Open Platform endpoints (`api.moonshot.*`) advertise
   *   `kimi-k3`, `kimi-k2.7-code`, and `kimi-k2.7-code-highspeed`.
   */
  private static resolveUpstreamModelId(
    modelId: string,
    baseUrl?: string,
    region?: KimiRegion
  ): string {
    const id = KimiProvider.normalizeKimiModelId(modelId);
    let useLegacy = false;
    if (baseUrl) {
      if (KimiProvider.isModernMoonshotOpenPlatformEndpoint(baseUrl)) {
        useLegacy = false;
      } else if (KimiProvider.isLegacyKimiCodeEndpoint(baseUrl)) {
        useLegacy = true;
      } else {
        // Unknown/custom base URL: default to legacy for China (and the default
        // no-region case), modern for global. This preserves legacy IDs for
        // custom China proxies while still letting global-only custom endpoints
        // use modern Open Platform IDs.
        useLegacy = region !== 'global';
      }
    } else {
      useLegacy = region !== 'global';
    }
    if (id === 'k3' || id === 'kimi-k3' || id.startsWith('moonshot-k3')) {
      return useLegacy ? 'k3' : 'kimi-k3';
    }
    if (id === 'kimi-k2.7-code-highspeed' || id === 'kimi-for-coding-highspeed') {
      return useLegacy ? 'kimi-for-coding-highspeed' : 'kimi-k2.7-code-highspeed';
    }
    if (
      id === 'kimi-k2.7-code' ||
      id === 'kimi' ||
      id === 'kimi-for-coding' ||
      id.startsWith('moonshot-')
    ) {
      return useLegacy ? 'kimi-for-coding' : 'kimi-k2.7-code';
    }
    return useLegacy ? 'kimi-for-coding' : 'kimi-k2.7-code';
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

    const effectiveRegion = explicitRegion
      ? resolveKimiRegion(explicitRegion)
      : (KimiProvider.resolveRegionFromBaseUrl(baseUrl) ?? this.defaultRegion);

    const contextWindow = KimiProvider.resolveContextWindow(_modelId);
    const routingModelId = KimiProvider.resolveUpstreamModelId(_modelId, baseUrl, effectiveRegion);

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
   * Use the provider default model for title generation. The title helper now
   * enables thinking for Kimi K2.7 and omits it for K3, so the default region
   * model works on both legacy and global endpoints.
   */
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
    // Kimi uses Moonshot's native Anthropic-compatible endpoint directly.
  }
}

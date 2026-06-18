/**
 * Kimi Provider - Moonshot AI（月之暗面）
 *
 * Kimi Code exposes a native Anthropic-compatible API in two regions:
 *
 * - China (`api.kimi.com`): `https://api.kimi.com/coding/` — the original
 *   domestic endpoint. Default for backward compatibility.
 * - Global (`api.moonshot.ai`): `https://api.moonshot.ai/anthropic` — for
 *   users outside China.
 *
 * The API uses a single fixed model ID `kimi-for-coding` that automatically
 * maps to the latest Kimi flagship model.
 *
 * Region is read from `sessionConfig.region` (string `'china' | 'global'`)
 * falling back to `'china'` for backward compatibility with existing
 * credentials that predate region support. An explicit `sessionConfig.baseUrl`
 * always wins (used by tests and advanced overrides).
 *
 * API Documentation: https://www.kimi.com/code/docs/
 */

import type { ModelInfo } from '@neokai/shared';
import type {
  ModelTier,
  Provider,
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderCredentials,
  ProviderSdkConfig,
  ProviderSessionConfig,
} from '@neokai/shared/provider';
import { probeAnthropicCompatCredentials } from './shared/credential-probe.js';

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Region identifiers supported by the Kimi provider.
 *
 * - `china`  — domestic endpoint at `api.kimi.com`.
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
  { anthropicBaseUrl: string; openAiBaseUrl: string }
> = {
  china: {
    anthropicBaseUrl: 'https://api.kimi.com/coding',
    openAiBaseUrl: 'https://api.kimi.com/coding/v1',
  },
  global: {
    anthropicBaseUrl: 'https://api.moonshot.ai/anthropic',
    openAiBaseUrl: 'https://api.moonshot.ai/v1',
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
    maxContextWindow: 262144,
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
      // Kimi accepts alternate model spellings (including case variants and
      // moonshot-* IDs) that all normalise to kimi-for-coding at the bridge
      // layer. List provider-accepted aliases here so model-service lookups
      // (used by getSessionModelInfo → context bar display and NeoKai fallback
      // threshold) resolve them to the canonical Kimi entry instead of returning
      // null. Without this, sessions whose stored model is a moonshot-* ID have
      // SDK auto-compact disabled (via buildProviderSettings) AND no NeoKai
      // fallback threshold — they would run into Kimi's real context limit with
      // no compaction trigger.
      providerAliases: ['KIMI', 'Kimi'],
      providerAliasPrefixes: ['moonshot-'],
      // Kimi's real context window is 262k but the SDK's PP() helper returns
      // 200k for unknown model IDs (and there is no [1m] suffix we can use
      // without breaking the upstream Kimi API call). We must trust this
      // metadata for the context bar display; compaction is handled by
      // NeoKai's fallback trigger (sdk-message-handler) rather than the SDK's
      // native auto-compact, because the SDK would cap the window to 200k
      // and fire compaction 60k too early.
      preferContextWindowMetadata: true,
      description:
        'Kimi Code model (auto-upgrades to latest flagship). Fixed model ID for all requests.',
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
   * Cached credential-probe result keyed by `{baseUrl}::{apiKey}` so that
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
  private async verifyCredentials(baseUrl: string, apiKey: string): Promise<void> {
    const cacheKey = `${baseUrl}::${apiKey}`;
    const cached = this.probeCache.get(cacheKey);
    if (cached && Date.now() - cached.at < KimiProvider.PROBE_TTL_MS) {
      // Re-throw the cached failure or resolve the cached success.
      await cached.result;
      return;
    }
    const result = probeAnthropicCompatCredentials({
      baseUrl,
      apiKey,
      model: KimiProvider.DEFAULT_MODEL,
      providerName: 'Kimi',
      fetchImpl: this.fetchImpl,
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
    // Use the default Kimi base URL for the probe — session overrides are
    // applied at request time via buildSdkConfig(), not here.
    await this.verifyCredentials(KimiProvider.BASE_URL, apiKey);
    return KimiProvider.MODELS;
  }

  ownsModel(modelId: string): boolean {
    const id = modelId.toLowerCase();
    return id === 'kimi' || id === 'kimi-for-coding' || id.startsWith('moonshot-');
  }

  getModelForTier(_tier: ModelTier): string | undefined {
    return KimiProvider.DEFAULT_MODEL;
  }

  buildSdkConfig(_modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    const apiKey = sessionConfig?.apiKey || this.getApiKey();
    if (!apiKey) {
      throw new Error('Kimi API key not configured. Set KIMI_API_KEY or MOONSHOT_API_KEY.');
    }

    // Resolve base URL: explicit sessionConfig.baseUrl wins, otherwise pick the
    // region endpoint. Per-session region overrides the provider-level default
    // region (set from the providers table configJson); both default to 'china'
    // for backward compatibility with pre-region credentials.
    const region = resolveKimiRegion(sessionConfig?.region ?? this.defaultRegion);
    const regionBaseUrl = KimiProvider.getBaseUrlForRegion(region);
    const baseUrl = normalizeBaseUrl(sessionConfig?.baseUrl || regionBaseUrl);
    // All Kimi Code requests use the fixed model ID.
    const routingModelId = KimiProvider.DEFAULT_MODEL;

    return {
      envVars: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: apiKey,
        API_TIMEOUT_MS: '3000000',
        // Explicitly clear CLAUDE_CODE_AUTO_COMPACT_WINDOW so a previous
        // provider's value (e.g. GLM's 1M, Codex's 272k) cannot leak into
        // the Kimi subprocess. The SDK's PP() helper returns 200k for the
        // unknown 'kimi-for-coding' model ID, so even an inherited 262144
        // value would cap the effective window to min(200k, 262k) = 200k
        // and make SDK auto-compact fire ~60k too early. SDK auto-compact
        // is disabled via Options.settings.autoCompactEnabled=false (set
        // by buildProviderSettings); NeoKai's fallback trigger handles
        // compaction at the correct 85% of the real 262k window. The empty
        // string deletes the env var when applied (see applyEnvVars in
        // provider-service.ts).
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: routingModelId,
        ANTHROPIC_DEFAULT_SONNET_MODEL: routingModelId,
        ANTHROPIC_DEFAULT_OPUS_MODEL: routingModelId,
      },
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  translateModelIdForSdk(modelId: string): string {
    // Return actual model ID so user-selected model is used.
    // Returning 'default' allows ~/.claude/settings.json overrides
    // (ANTHROPIC_DEFAULT_SONNET_MODEL) to incorrectly redirect to other providers.
    return modelId === 'kimi' ? KimiProvider.DEFAULT_MODEL : modelId;
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
    // Kimi uses Moonshot's native Anthropic-compatible endpoint directly.
  }
}

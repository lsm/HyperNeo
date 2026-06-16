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
 * ## Bridge architecture
 *
 * The Claude Agent SDK has a hardcoded table of known model context windows.
 * It does not recognise `kimi-for-coding` and falls back to a ~200 k default,
 * rejecting requests that fit within Kimi's 262 k window.  To work around
 * this, the provider routes SDK traffic through a lightweight local bridge that
 * intercepts `GET /v1/models` and returns the correct context window metadata.
 * All other requests are proxied verbatim to Kimi's API — no protocol
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
import {
  createAnthropicMessagesBridgeServer,
  type AnthropicMessagesBridgeServer,
} from './anthropic-messages-bridge/server.js';
import { Logger } from '../logger.js';
import * as crypto from 'crypto';

const logger = new Logger('kimi-provider');

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Return a short non-reversible fingerprint of `value` for log correlation. */
function keyFingerprint(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
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
 * Anthropic-compatible base URLs are used by the bridge (which forwards
 * `/v1/messages` traffic to the upstream Anthropic-compatible API). The
 * OpenAI-compatible endpoints are exposed for direct callers that prefer the
 * OpenAI schema (not currently used by the bridge).
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
   * Bridge servers keyed by `{baseUrl}::{apiKey}` so that sessions with
   * different per-session credentials get isolated bridges that forward
   * the correct auth upstream.  This avoids a singleton bridge leaking
   * one session's credentials into another session's requests.
   */
  private readonly bridgeServers = new Map<string, AnthropicMessagesBridgeServer>();

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly bridgeFactory: typeof createAnthropicMessagesBridgeServer = createAnthropicMessagesBridgeServer
  ) {
    this.env = env;
  }

  setCredentials(credentials: ProviderCredentials): void {
    this.credentials = credentials;
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

    // Resolve base URL: explicit sessionConfig.baseUrl wins, otherwise pick the
    // region endpoint. Per-session region overrides the provider-level default
    // region (set from the providers table configJson); both default to 'china'
    // for backward compatibility with pre-region credentials.
    const region = resolveKimiRegion(sessionConfig?.region ?? this.defaultRegion);
    const regionBaseUrl = KimiProvider.getBaseUrlForRegion(region);
    const baseUrl = normalizeBaseUrl(sessionConfig?.baseUrl || regionBaseUrl);
    // All Kimi Code requests use the fixed model ID
    const routingModelId = KimiProvider.DEFAULT_MODEL;

    // Lazily start a per-credentials bridge.  Keyed by `{baseUrl}::{apiKey}`
    // so sessions with different API keys or base URLs get isolated bridges
    // that forward the correct auth upstream.
    const bridgeKey = `${baseUrl}::${apiKey}`;
    let bridgeServer = this.bridgeServers.get(bridgeKey);
    if (!bridgeServer) {
      bridgeServer = this.bridgeFactory({
        baseUrl,
        apiKey,
        models: [
          {
            id: routingModelId,
            display_name: 'Kimi For Coding',
            context_window: 262144,
            max_tokens: 32768,
          },
        ],
      });
      this.bridgeServers.set(bridgeKey, bridgeServer);
      // Log a fingerprint, not the raw key — avoids leaking credential prefixes
      // in daemon logs.
      const logKey = `${baseUrl}::${keyFingerprint(apiKey)}`;
      logger.info(`Kimi bridge server started on port ${bridgeServer.port} for key=${logKey}`);
    }

    return {
      envVars: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridgeServer.port}`,
        // Blank ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN explicitly so
        // ProviderService clears any inherited Anthropic credentials from
        // process.env. The bridge handles Kimi auth via its config.apiKey;
        // the SDK subprocess does not need real Anthropic credentials.
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
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
    for (const [key, server] of this.bridgeServers) {
      server.stop();
      const [baseUrl, apiKey] = key.split('::');
      const logKey = `${baseUrl}::${keyFingerprint(apiKey)}`;
      logger.info(`Kimi bridge server stopped for key=${logKey}`);
    }
    this.bridgeServers.clear();
  }
}

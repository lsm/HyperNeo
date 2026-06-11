/**
 * Anthropic-to-Codex Bridge Provider
 *
 * Provides an Anthropic-compatible bridge for OpenAI-backed models.
 * The bridge speaks the Anthropic Messages API (POST /v1/messages with SSE
 * streaming) backed directly by OpenAI's Responses API.
 *
 * Authentication discovery for API calls (priority order):
 *   1. OPENAI_API_KEY environment variable (daemon/test use only)
 *   2. ~/.neokai/auth.json  — NeoKai's own auth store (key "openai")
 *   3. ~/.codex/auth.json   — imported once into ~/.neokai/auth.json (for users who ran `codex login`)
 *
 * UI authentication requires NeoKai-managed OAuth credentials in ~/.neokai/auth.json.
 * Env var credentials are used internally for API calls but not shown in the UI.
 * OAuth credentials obtained through NeoKai's login flow are written to
 * ~/.neokai/auth.json so they persist across sessions.
 *
 * Workspace isolation: each unique workspace path gets its own bridge server
 * so Codex is always rooted at the correct directory.
 */

import type {
  Provider,
  ProviderCapabilities,
  ProviderCredentials,
  ProviderSdkConfig,
  ProviderSessionConfig,
  ModelTier,
  ProviderAuthStatusInfo,
  ProviderOAuthFlowData,
} from '@neokai/shared/provider';
import type { ModelInfo } from '@neokai/shared';
import { THINKING_LEVEL_TOKENS } from '@neokai/shared';
import {
  type OpenAIResponsesBridgeAuth,
  type OpenAIResponsesBridgeServer,
  createOpenAIResponsesBridgeServer,
} from './openai-responses-bridge/server.js';
import {
  getCodexBridgeModelInfos,
  resolveCodexBridgeModelId,
  CODEX_TO_SDK_ANTHROPIC_MODEL,
  SDK_ANTHROPIC_TO_CODEX_MODEL,
} from './codex-models.js';
import { Logger } from '../logger.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as crypto from 'crypto';

const logger = new Logger('anthropic-to-codex-bridge-provider');

// ---------------------------------------------------------------------------
// Model catalogue
// ---------------------------------------------------------------------------

const ANTHROPIC_CODEX_MODELS = getCodexBridgeModelInfos();

// ---------------------------------------------------------------------------
// OAuth configuration (ChatGPT Plus / Pro)
// ---------------------------------------------------------------------------

const OAUTH_CONFIG = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  redirectUri: 'http://localhost:1455/auth/callback',
  scope: 'openid profile email offline_access',
  callbackPort: 1455,
};

// ---------------------------------------------------------------------------
// Auth credential types
// ---------------------------------------------------------------------------

/** Shape stored in ~/.neokai/auth.json under the "openai" key. */
interface StoredCredentials {
  type: 'oauth' | 'api_key';
  access?: string;
  refresh?: string;
  expires?: number; // Unix timestamp in ms
  accountId?: string;
  planType?: string;
  isFedrampAccount?: boolean;
}

/** Raw OAuth token response from auth.openai.com. */
export interface OpenAIOAuthToken {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  id_token?: string;
}

export type CodexRefreshResult =
  | { ok: true; token: OpenAIOAuthToken }
  | { ok: false; definitive: boolean };

/**
 * Exchange a Codex/OpenAI OAuth refresh token for a new access token.
 *
 * Returns `{ ok: true, token }` on success. On failure returns `{ ok: false,
 * definitive }` where `definitive` is `true` when the refresh token itself is
 * invalid/expired/revoked (4xx errors) and `false` for transient failures
 * (network errors, timeouts, 5xx, 429).
 *
 * Exported for provider auth discovery and online test setup helpers.
 */
export async function refreshCodexToken(
  refreshToken: string,
  timeoutMs = 5000
): Promise<CodexRefreshResult> {
  try {
    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CONFIG.clientId,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const body = await response.text();
      logger.warn(`AnthropicToCodexBridgeProvider: token refresh HTTP ${response.status}: ${body}`);
      // 4xx (except 408/429) means the refresh token is invalid — definitive.
      // 5xx and 429 are transient.
      const definitive =
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        response.status !== 429;
      return { ok: false, definitive };
    }
    const parsed = (await response.json()) as OpenAIOAuthToken;
    if (!parsed.access_token || typeof parsed.access_token !== 'string') {
      logger.warn('AnthropicToCodexBridgeProvider: token refresh response missing access_token');
      return { ok: false, definitive: true };
    }
    if (typeof parsed.expires_in !== 'number') {
      logger.warn('AnthropicToCodexBridgeProvider: token refresh response missing expires_in');
      return { ok: false, definitive: true };
    }
    return { ok: true, token: parsed };
  } catch (error) {
    logger.warn('AnthropicToCodexBridgeProvider: token refresh network error:', error);
    return { ok: false, definitive: false };
  }
}

/** Shape of ~/.codex/auth.json as written by the Codex CLI. */
interface CodexAuthFile {
  OPENAI_API_KEY?: string | null;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
    id_token?: string | Record<string, unknown>;
  };
  last_refresh?: string;
}

// ---------------------------------------------------------------------------
// Anthropic-to-Codex Bridge Provider
// ---------------------------------------------------------------------------

export class AnthropicToCodexBridgeProvider implements Provider {
  readonly id = 'anthropic-codex';
  readonly displayName = 'OpenAI (Codex)';

  get capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      // GPT-5.5 supports reasoning.effort via the OpenAI Responses API; the bridge
      // translates OpenAI reasoning events to Anthropic thinking SSE blocks.
      extendedThinking: true,
      thinkingModes: 'granular',
      maxContextWindow: 272000,
      functionCalling: true,
      vision: true,
    };
  }

  /** Responses bridge servers, shared by auth. */
  private readonly bridgeServers = new Map<string, OpenAIResponsesBridgeServer>();
  private readonly bridgeServerAuthKeys = new Map<string, string>();

  /** Path to NeoKai's own auth store. */
  private readonly authPath: string;

  /** Path to the Codex CLI auth file. */
  private readonly codexAuthPath: string;

  /** In-memory cache of credentials read from the NeoKai auth file. */
  private cachedCredentials: StoredCredentials | null = null;
  private readonly credentialListeners = new Set<
    (credentials: ProviderCredentials) => void | Promise<void>
  >();

  /**
   * Cached resolved bridge auth.
   * undefined = unresolved, null = resolved but unavailable.
   */
  private cachedBridgeAuth: OpenAIResponsesBridgeAuth | null | undefined = undefined;

  /**
   * Backward-compatibility cache for the legacy getApiKey() return path.
   * undefined = unresolved, '' = resolved unavailable, non-empty = resolved.
   */
  private cachedApiKey: string | undefined = undefined;

  /** Active OAuth flow state (PKCE flow). */
  private activeOAuthFlow: {
    state: string;
    verifier: string;
    server: http.Server | null;
    completed: boolean;
    success: boolean;
  } | null = null;

  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    authDir?: string,
    codexAuthDir?: string
  ) {
    this.authPath = path.join(authDir ?? path.join(os.homedir(), '.neokai'), 'auth.json');
    this.codexAuthPath = path.join(codexAuthDir ?? path.join(os.homedir(), '.codex'), 'auth.json');
  }

  async isAvailable(): Promise<boolean> {
    return (await this.getBridgeAuth()) !== undefined;
  }

  setCredentials(credentials: ProviderCredentials): void {
    if (credentials.type === 'api_key') {
      this.cachedCredentials = { type: 'api_key', access: credentials.apiKey };
      this.cachedBridgeAuth = { source: 'api_key', apiKey: credentials.apiKey };
      this.cachedApiKey = credentials.apiKey;
      return;
    }

    const raw = credentials.raw ?? {};
    const stored: StoredCredentials = {
      type: 'oauth',
      access: credentials.accessToken,
      refresh: credentials.refreshToken,
      expires: credentials.expiresAt,
      accountId: typeof raw.accountId === 'string' ? raw.accountId : undefined,
      planType: typeof raw.planType === 'string' ? raw.planType : undefined,
      isFedrampAccount:
        typeof raw.isFedrampAccount === 'boolean' ? raw.isFedrampAccount : undefined,
    };
    this.cachedCredentials = stored;
    this.cachedBridgeAuth = this.toBridgeAuth(stored) ?? null;
    this.cachedApiKey = stored.access ?? '';
  }

  async getCredentials(): Promise<ProviderCredentials | null> {
    let credentials = await this.loadCredentials();
    if (!credentials) {
      // Import from ~/.codex/auth.json if the user has valid Codex CLI
      // credentials but no NeoKai auth file, so startup reconciliation
      // sees provider-owned credentials before applying stale rows.
      await this.importFromCodexAuth();
      credentials = await this.loadCredentials();
    }
    if (!credentials) return null;
    if (credentials.type === 'api_key' && credentials.access) {
      return { type: 'api_key', apiKey: credentials.access };
    }
    return this.toProviderCredentials(credentials);
  }

  onCredentialsChanged(
    listener: (credentials: ProviderCredentials) => void | Promise<void>
  ): () => void {
    this.credentialListeners.add(listener);
    return () => this.credentialListeners.delete(listener);
  }

  private notifyCredentialsChanged(credentials: ProviderCredentials): void {
    for (const listener of this.credentialListeners) {
      void listener(credentials);
    }
  }

  private toProviderCredentials(credentials: StoredCredentials): ProviderCredentials {
    return {
      type: 'oauth',
      accessToken: credentials.access,
      refreshToken: credentials.refresh,
      expiresAt: credentials.expires,
      raw: {
        accountId: credentials.accountId,
        planType: credentials.planType,
        isFedrampAccount: credentials.isFedrampAccount,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Auth status & credential discovery
  // -------------------------------------------------------------------------

  /**
   * Return provider credentials, following discovery order:
   *   1. OPENAI_API_KEY env var
   *   2. ~/.neokai/auth.json["openai"]
   *   3. One-time migration from ~/.codex/auth.json into ~/.neokai/auth.json
   */
  private async getBridgeAuth(): Promise<OpenAIResponsesBridgeAuth | undefined> {
    if (this.env.OPENAI_API_KEY) {
      return { source: 'api_key', apiKey: this.env.OPENAI_API_KEY };
    }

    if (this.cachedBridgeAuth !== undefined) {
      return this.cachedBridgeAuth ?? undefined;
    }

    const neokaiCreds = await this.loadCredentials();
    if (neokaiCreds?.access) {
      const auth = this.toBridgeAuth(neokaiCreds);
      this.cachedBridgeAuth = auth ?? null;
      this.cachedApiKey = neokaiCreds.access;
      return auth;
    }

    await this.importFromCodexAuth();
    const importedCreds = await this.loadCredentials();
    if (importedCreds?.access) {
      const auth = this.toBridgeAuth(importedCreds);
      this.cachedBridgeAuth = auth ?? null;
      this.cachedApiKey = importedCreds.access;
      return auth;
    }

    this.cachedBridgeAuth = null;
    this.cachedApiKey = '';
    return undefined;
  }

  /**
   * Backward-compatible helper used by call sites that still ask for "api key".
   * For OAuth mode this returns the OAuth access token.
   */
  async getApiKey(): Promise<string | undefined> {
    const auth = await this.getBridgeAuth();
    return auth?.apiKey;
  }

  private toBridgeAuth(credentials: StoredCredentials): OpenAIResponsesBridgeAuth | undefined {
    if (!credentials.access) return undefined;
    if (credentials.type === 'api_key') {
      return { source: 'api_key', apiKey: credentials.access };
    }

    const accountId = credentials.accountId ?? this.extractAccountId(credentials.access);
    if (!accountId) {
      // Fallback for legacy malformed entries: treat unknown oauth "access" as API key.
      return { source: 'api_key', apiKey: credentials.access };
    }

    return {
      source: 'chatgpt_oauth',
      apiKey: credentials.access,
      accountId,
      isFedrampAccount:
        credentials.isFedrampAccount ?? this.extractIsFedrampAccount(credentials.access),
      refreshAuthTokens: async () => {
        const refreshed = await this.refreshStoredOauthCredentials();
        if (!refreshed?.access) return null;
        const refreshedAccountId = refreshed.accountId ?? this.extractAccountId(refreshed.access);
        if (!refreshedAccountId) return null;
        return {
          accessToken: refreshed.access,
          accountId: refreshedAccountId,
          isFedrampAccount:
            refreshed.isFedrampAccount ?? this.extractIsFedrampAccount(refreshed.access),
        };
      },
    };
  }

  private bridgeAuthCacheKey(auth: OpenAIResponsesBridgeAuth | undefined): string {
    if (!auth) return 'none';
    if (auth.source === 'api_key') return `api_key:${auth.apiKey}`;
    return [
      'chatgpt',
      auth.apiKey,
      auth.accountId,
      auth.isFedrampAccount ? 'fedramp' : 'standard',
    ].join(':');
  }

  /**
   * Resolve the active bridge auth using the same precedence as buildSdkConfig:
   *   1. OPENAI_API_KEY env var
   *   2. Cached credentials file
   *   3. cachedBridgeAuth (from prior OAuth flow)
   */
  private resolveBridgeAuth(): OpenAIResponsesBridgeAuth | undefined {
    const envAuth = this.env.OPENAI_API_KEY
      ? ({ source: 'api_key', apiKey: this.env.OPENAI_API_KEY } as const)
      : undefined;
    const fileAuth = this.cachedCredentials ? this.toBridgeAuth(this.cachedCredentials) : undefined;
    return envAuth ?? this.cachedBridgeAuth ?? fileAuth ?? undefined;
  }

  private modelAliases(): Record<string, string> {
    const userAliases = Object.fromEntries(
      ANTHROPIC_CODEX_MODELS.flatMap((model) =>
        model.alias ? [[model.alias, model.id] as const] : []
      )
    );
    // Map Anthropic SDK model IDs back to real Codex IDs so the bridge
    // forwards the correct model to OpenAI.
    const sdkAliases = Object.fromEntries(
      Object.entries(SDK_ANTHROPIC_TO_CODEX_MODEL).map(([anthropicId, codexId]) => [
        anthropicId,
        codexId,
      ])
    );
    return { ...userAliases, ...sdkAliases };
  }

  private responsesBridgeModels() {
    const codexModels = ANTHROPIC_CODEX_MODELS.map((model) => ({
      id: model.id,
      display_name: model.name,
      created_at: `${model.releaseDate ?? '2026-01-01'}T00:00:00Z`,
      context_window: model.contextWindow,
      max_tokens: 16384,
    }));
    // Also advertise the Anthropic SDK aliases so the SDK can look them up
    // if it queries the models list for context window info. The Opus alias must
    // report the SDK-facing Anthropic limit because it is used for primary routing;
    // the Sonnet/mini alias reports the real mini limit because Haiku-tier requests
    // still use it directly. NeoKai separately uses Codex ModelInfo metadata plus
    // ContextTracker to compact at 85% of the real upstream window before OpenAI
    // sees the request.
    const anthropicModels = [
      {
        id: 'claude-opus-4-1-20250805',
        display_name: 'Claude Opus 4.1 (Codex bridge)',
        created_at: '2025-08-05T00:00:00Z',
        context_window: 1_000_000,
        max_tokens: 16384,
      },
      {
        id: 'claude-sonnet-4-20250514',
        display_name: 'Claude Sonnet 4 (Codex bridge)',
        created_at: '2025-05-14T00:00:00Z',
        context_window: 128_000,
        max_tokens: 16384,
      },
    ];
    return [...codexModels, ...anthropicModels];
  }

  private async refreshStoredOauthCredentials(): Promise<StoredCredentials | undefined> {
    const credentials = await this.loadCredentials();
    if (!credentials || credentials.type !== 'oauth' || !credentials.refresh) {
      return undefined;
    }

    const result = await this.tryRefreshCodexToken(credentials.refresh);
    if (!result.ok) {
      if (result.definitive) {
        logger.warn(
          'AnthropicToCodexBridgeProvider: OAuth token refresh failed — clearing stale credentials'
        );
        await this.logout();
      } else {
        logger.warn(
          'AnthropicToCodexBridgeProvider: OAuth token refresh transient failure — preserving credentials'
        );
      }
      return undefined;
    }

    const newCreds: StoredCredentials = {
      type: 'oauth',
      access: result.token.access_token,
      refresh: result.token.refresh_token || credentials.refresh,
      expires: Date.now() + result.token.expires_in * 1000,
      accountId: this.extractAccountId(result.token.access_token) ?? credentials.accountId,
      planType: this.extractPlanType(result.token.access_token) ?? credentials.planType,
      isFedrampAccount:
        this.extractIsFedrampAccount(result.token.id_token ?? result.token.access_token) ??
        credentials.isFedrampAccount,
    };

    await this.saveCredentials(newCreds);
    this.cachedCredentials = newCreds;
    this.cachedBridgeAuth = this.toBridgeAuth(newCreds) ?? null;
    this.cachedApiKey = newCreds.access ?? '';
    return newCreds;
  }

  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    // Only NeoKai-managed OAuth credentials are recognised in the UI.
    // OPENAI_API_KEY env vars are for daemon/test use only.
    const neokaiCreds = await this.loadCredentials();
    if (!neokaiCreds || neokaiCreds.type !== 'oauth') {
      return {
        isAuthenticated: false,
        error: neokaiCreds
          ? 'API key credentials are not supported via the UI. Click Login to authenticate with OpenAI OAuth.'
          : 'Not logged in. Click Login to authenticate with OpenAI.',
      };
    }

    if (neokaiCreds.expires) {
      const bufferMs = 5 * 60 * 1000;
      if (Date.now() >= neokaiCreds.expires - bufferMs) {
        return {
          isAuthenticated: true,
          method: 'oauth',
          expiresAt: neokaiCreds.expires,
          needsRefresh: true,
        };
      }
      return { isAuthenticated: true, method: 'oauth', expiresAt: neokaiCreds.expires };
    }

    return { isAuthenticated: true, method: 'oauth' };
  }

  async getModels(): Promise<ModelInfo[]> {
    // Use isAvailable() (which includes env-var credentials via getBridgeAuth()) so
    // that the model picker works for all credential sources.  getAuthStatus() is
    // UI-only: it gates the Login/Logout buttons but must not hide models from users
    // who authenticate via OPENAI_API_KEY env vars.
    if (!(await this.isAvailable())) return [];
    return ANTHROPIC_CODEX_MODELS.map((m) => ({ ...m, thinkingModes: 'granular' as const }));
  }

  ownsModel(modelId: string): boolean {
    // Only claim model IDs that are explicitly listed in our catalogue.
    // This avoids hijacking other providers' models (e.g. gpt-4, gpt-4o).
    return ANTHROPIC_CODEX_MODELS.some((m) => m.id === modelId || m.alias === modelId);
  }

  translateModelIdForSdk(modelId: string): string {
    const resolved = resolveCodexBridgeModelId(modelId) ?? modelId;
    return (
      CODEX_TO_SDK_ANTHROPIC_MODEL[resolved as import('./codex-models.js').CodexBridgeModelId] ??
      resolved
    );
  }

  getModelForTier(tier: ModelTier): string | undefined {
    // Routing policy:
    //   opus    → gpt-5.5           (latest frontier, matches ANTHROPIC_DEFAULT_OPUS_MODEL)
    //   sonnet  → gpt-5.3-codex     (primary Codex model, matches ANTHROPIC_DEFAULT_SONNET_MODEL)
    //   haiku   → gpt-5.4-mini       (fast/cheap, matches ANTHROPIC_DEFAULT_HAIKU_MODEL)
    //   default → gpt-5.3-codex     (same as sonnet; no separate env var needed)
    const map: Record<ModelTier, string> = {
      opus: 'gpt-5.5',
      sonnet: 'gpt-5.3-codex',
      haiku: 'gpt-5.4-mini',
      default: 'gpt-5.3-codex',
    };
    return map[tier];
  }

  // -------------------------------------------------------------------------
  // Bridge server management
  // -------------------------------------------------------------------------

  /**
   * Build SDK configuration.
   *
   * Lazily starts a per-workspace bridge server and returns env vars that
   * route the Anthropic SDK to that bridge's local HTTP endpoint.
   */
  buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    const sessionId = sessionConfig?.sessionId ?? 'default';
    // buildSdkConfig() is synchronous per the Provider interface.  The async
    // discovery chain populates cachedBridgeAuth via isAvailable()/getAuthStatus().
    const auth = this.resolveBridgeAuth();
    const authKey = this.bridgeAuthCacheKey(auth);
    const bridgeKey = `responses:${authKey}`;
    let bridgeServer = this.bridgeServers.get(bridgeKey);
    for (const [key, server] of this.bridgeServers) {
      if (key === bridgeKey) continue;
      server.stop();
      this.bridgeServers.delete(key);
      this.bridgeServerAuthKeys.delete(key);
    }
    // Resolve alias (e.g. 'codex' → 'gpt-5.3-codex') so ANTHROPIC_DEFAULT_*_MODEL
    // receives real OpenAI model IDs that the bridge can forward upstream.
    const entry = ANTHROPIC_CODEX_MODELS.find((m) => m.alias === modelId || m.id === modelId);
    if (!entry) {
      throw new Error(`Unknown Codex model: ${modelId}`);
    }
    const resolvedId = entry.id;

    if (!bridgeServer) {
      if (!auth) {
        logger.warn(
          'AnthropicToCodexBridgeProvider: starting Responses bridge without resolved auth; requests will fail until credentials are available'
        );
      }
      bridgeServer = createOpenAIResponsesBridgeServer({
        auth: auth ?? { source: 'api_key', apiKey: '' },
        models: this.responsesBridgeModels(),
        modelAliases: this.modelAliases(),
      });
      this.bridgeServers.set(bridgeKey, bridgeServer);
      this.bridgeServerAuthKeys.set(bridgeKey, authKey);
      logger.info(
        `AnthropicToCodexBridgeProvider: Responses bridge server started on port ${bridgeServer.port} for key=${bridgeKey}`
      );
    }

    const bridgeBaseUrl =
      bridgeServer.baseUrlForSession?.(sessionId) || `http://127.0.0.1:${bridgeServer.port}`;

    const sdkAnthropicId =
      CODEX_TO_SDK_ANTHROPIC_MODEL[resolvedId as import('./codex-models.js').CodexBridgeModelId];
    if (!sdkAnthropicId) {
      throw new Error(`Unknown Codex model: ${modelId}`);
    }

    // Register per-session overrides so the bridge sends the originally-selected
    // Codex model ID upstream instead of the default alias target. Without this,
    // shared SDK aliases would collapse to their default Codex mappings. Sonnet is
    // routed through the Opus alias for SDK preflight safety, so primary mini
    // sessions also register the Opus alias. Fallback model contexts must not do
    // that extra Opus registration: otherwise a mini fallback would overwrite a
    // frontier primary route before fallback is triggered.
    bridgeServer.setSessionModelConfig?.(sessionId, sdkAnthropicId, resolvedId);
    if (!sessionConfig?.isFallbackModelContext) {
      bridgeServer.setSessionModelConfig?.(
        sessionId,
        CODEX_TO_SDK_ANTHROPIC_MODEL['gpt-5.5'],
        resolvedId
      );
    }

    return {
      envVars: {
        ANTHROPIC_BASE_URL: bridgeBaseUrl,
        ANTHROPIC_API_KEY: `codex-bridge-${sessionId}`,
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        // Present Anthropic model IDs with known large context windows to the
        // Claude Agent SDK so it does not fall back to its default ~200 k limit
        // and reject requests prematurely. The bridge maps these back to real
        // Codex IDs via modelAliases (plus per-session overrides) before
        // forwarding to OpenAI.
        // Route the SDK's primary tiers through Opus so its preflight context
        // checks use the large Anthropic limit. The bridge maps that alias back
        // to the real selected Codex model per session before calling OpenAI.
        // Haiku remains on the mini-tier alias for cheap/fast sub-agent routing.
        ANTHROPIC_DEFAULT_OPUS_MODEL: CODEX_TO_SDK_ANTHROPIC_MODEL['gpt-5.5'],
        ANTHROPIC_DEFAULT_SONNET_MODEL: CODEX_TO_SDK_ANTHROPIC_MODEL['gpt-5.5'],
        ANTHROPIC_DEFAULT_HAIKU_MODEL: CODEX_TO_SDK_ANTHROPIC_MODEL['gpt-5.4-mini'],
      },
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  /**
   * Propagate the session's thinking level to the Responses bridge.
   *
   * The Claude Code CLI handles thinking internally and does not include the
   * thinking field in Anthropic Messages API request bodies. Without this
   * side-channel the bridge has no way to know that reasoning should be
   * forwarded to the OpenAI Responses API.
   */
  setSessionThinkingConfig(sessionId: string, thinkingLevel: string | undefined): void {
    const auth = this.resolveBridgeAuth();
    const authKey = this.bridgeAuthCacheKey(auth);
    const bridgeKey = `responses:${authKey}`;
    const bridgeServer = this.bridgeServers.get(bridgeKey);
    if (!bridgeServer?.setSessionThinkingConfig) return;

    const tokens = THINKING_LEVEL_TOKENS[thinkingLevel as keyof typeof THINKING_LEVEL_TOKENS];
    if (tokens === undefined) {
      bridgeServer.setSessionThinkingConfig(sessionId, undefined);
      return;
    }

    bridgeServer.setSessionThinkingConfig(sessionId, {
      type: 'enabled',
      budget_tokens: tokens,
    });
  }

  /** Stop all bridge servers and reset cached auth state. Called at provider shutdown (e.g. tests). */
  stopAllBridgeServers(): void {
    for (const server of this.bridgeServers.values()) {
      server.stop();
    }
    this.bridgeServers.clear();
    this.bridgeServerAuthKeys.clear();
    // Reset cached auth so a new provider instance starts with a clean slate.
    // Without this, cachedBridgeAuth=null from a previous run would cause
    // isAvailable() to return false even when valid credentials are present.
    this.cachedCredentials = null;
    this.cachedBridgeAuth = undefined;
    this.cachedApiKey = undefined;
  }

  /** @deprecated Use stopAllBridgeServers(). */
  stopBridgeServer(): void {
    this.stopAllBridgeServers();
  }

  // -------------------------------------------------------------------------
  // OAuth flow (ChatGPT Plus / Pro)
  // -------------------------------------------------------------------------

  async startOAuthFlow(): Promise<ProviderOAuthFlowData> {
    if (this.activeOAuthFlow && !this.activeOAuthFlow.completed) {
      return {
        type: 'redirect',
        authUrl: this.activeOAuthFlow.state
          ? this.buildAuthUrl(
              this.activeOAuthFlow.state,
              await this.generatePKCEChallenge(this.activeOAuthFlow.verifier)
            ).toString()
          : undefined,
        message: 'OAuth flow already in progress. Complete authentication in your browser.',
      };
    }

    const verifier = this.generateRandomString(128);
    const challenge = await this.generatePKCEChallenge(verifier);
    const state = this.generateRandomString(32);
    const authUrl = this.buildAuthUrl(state, challenge);

    this.activeOAuthFlow = { state, verifier, server: null, completed: false, success: false };

    this.startBackgroundOAuthFlow(state, verifier).catch((error) => {
      logger.error('Background OAuth flow failed:', error);
      if (this.activeOAuthFlow) {
        this.activeOAuthFlow.completed = true;
        this.activeOAuthFlow.success = false;
      }
    });

    return {
      type: 'redirect',
      authUrl: authUrl.toString(),
      message: 'Opening browser for OpenAI authentication...',
    };
  }

  private buildAuthUrl(state: string, challenge: string): URL {
    const authUrl = new URL(OAUTH_CONFIG.authorizeUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', OAUTH_CONFIG.clientId);
    authUrl.searchParams.set('redirect_uri', OAUTH_CONFIG.redirectUri);
    authUrl.searchParams.set('scope', OAUTH_CONFIG.scope);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('id_token_add_organizations', 'true');
    authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
    authUrl.searchParams.set('originator', 'neokai');
    return authUrl;
  }

  private async startBackgroundOAuthFlow(expectedState: string, verifier: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');

        if (url.pathname !== '/auth/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }

        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');

        if (state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid state parameter');
          server.close();
          reject(new Error('Invalid state parameter'));
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('No authorization code received');
          server.close();
          reject(new Error('No authorization code received'));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h1>Authentication successful!</h1><p>You can close this window and return to NeoKai.</p><script>window.close();</script></body></html>'
        );
        server.close();

        this.exchangeCodeForTokens(code, verifier)
          .then((tokens) => {
            const credentials: StoredCredentials = {
              type: 'oauth',
              access: tokens.access_token,
              refresh: tokens.refresh_token,
              expires: Date.now() + tokens.expires_in * 1000,
              accountId: this.extractAccountId(tokens.access_token),
              planType: this.extractPlanType(tokens.access_token),
              isFedrampAccount: this.extractIsFedrampAccount(
                tokens.id_token ?? tokens.access_token
              ),
            };
            return this.saveCredentials(credentials).then(() => {
              this.cachedCredentials = credentials;
              this.cachedBridgeAuth = this.toBridgeAuth(credentials) ?? null;
              this.cachedApiKey = credentials.access ?? '';
              this.notifyCredentialsChanged(this.toProviderCredentials(credentials));
              if (this.activeOAuthFlow) {
                this.activeOAuthFlow.completed = true;
                this.activeOAuthFlow.success = true;
              }
              resolve();
            });
          })
          .catch((error) => {
            logger.error('Token exchange failed:', error);
            if (this.activeOAuthFlow) {
              this.activeOAuthFlow.completed = true;
              this.activeOAuthFlow.success = false;
            }
            reject(error as Error);
          });
      });

      if (this.activeOAuthFlow) this.activeOAuthFlow.server = server;

      server.listen(OAUTH_CONFIG.callbackPort, () => {
        logger.debug(`OAuth callback server listening on port ${OAUTH_CONFIG.callbackPort}`);
      });

      setTimeout(
        () => {
          server.close();
          if (this.activeOAuthFlow && !this.activeOAuthFlow.completed) {
            this.activeOAuthFlow.completed = true;
            this.activeOAuthFlow.success = false;
          }
          reject(new Error('OAuth flow timed out'));
        },
        5 * 60 * 1000
      );
    });
  }

  private async exchangeCodeForTokens(code: string, verifier: string): Promise<OpenAIOAuthToken> {
    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: OAUTH_CONFIG.redirectUri,
        client_id: OAUTH_CONFIG.clientId,
        code_verifier: verifier,
      }),
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<OpenAIOAuthToken>;
  }

  async refreshToken(): Promise<boolean> {
    const credentials = await this.loadCredentials();
    if (!credentials?.refresh) return false;

    const result = await this.refreshStoredOauthCredentials();
    return result !== undefined;
  }

  async logout(): Promise<void> {
    this.cachedCredentials = null;
    this.cachedBridgeAuth = undefined;
    this.cachedApiKey = undefined; // reset so the next getApiKey() re-reads from disk
    try {
      const content = await fs.readFile(this.authPath, 'utf-8');
      const data = JSON.parse(content) as Record<string, unknown>;
      delete data['openai'];

      if (Object.keys(data).length === 0) {
        await fs.unlink(this.authPath);
      } else {
        // Atomic write to avoid partial-write corruption (same pattern as saveCredentials)
        const json = JSON.stringify(data, null, 2);
        const tmpPath = `${this.authPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
        try {
          await fs.writeFile(tmpPath, json, { mode: 0o600 });
          await fs.rename(tmpPath, this.authPath);
        } catch (err) {
          await fs.unlink(tmpPath).catch(() => {});
          throw err;
        }
      }
    } catch {
      // file does not exist — nothing to do
    }
  }

  // -------------------------------------------------------------------------
  // Private: credential persistence
  // -------------------------------------------------------------------------

  private async loadCredentials(): Promise<StoredCredentials | null> {
    if (this.cachedCredentials) return this.cachedCredentials;

    try {
      const content = await fs.readFile(this.authPath, 'utf-8');
      const data = JSON.parse(content) as Record<string, unknown>;
      const creds = data['openai'] as StoredCredentials | undefined;
      if (creds?.access) {
        this.cachedCredentials = creds;
        return creds;
      }
    } catch {
      // file missing or malformed — continue to next source
    }
    return null;
  }

  private async saveCredentials(credentials: StoredCredentials): Promise<void> {
    const dir = path.dirname(this.authPath);
    await fs.mkdir(dir, { recursive: true });

    let data: Record<string, unknown> = {};
    try {
      const existing = await fs.readFile(this.authPath, 'utf-8');
      data = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      // file does not exist yet
    }

    data['openai'] = credentials;
    const json = JSON.stringify(data, null, 2);

    // Atomic write: write to a temp file then rename so partial writes never
    // corrupt the auth store.
    const tmpPath = `${this.authPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.writeFile(tmpPath, json, { mode: 0o600 });
      await fs.rename(tmpPath, this.authPath);
    } catch (err) {
      // Clean up the temp file on failure
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  /**
   * One-time migration: read credentials from ~/.codex/auth.json, optionally
   * refresh the access token, and write to ~/.neokai/auth.json.
   */
  private async importFromCodexAuth(): Promise<void> {
    let codexData: CodexAuthFile;
    try {
      const raw = await fs.readFile(this.codexAuthPath, 'utf-8');
      codexData = JSON.parse(raw) as CodexAuthFile;
    } catch {
      return; // file missing or malformed
    }

    // Case 1: explicit API key (not an OAuth token) — import directly.
    if (codexData.OPENAI_API_KEY && typeof codexData.OPENAI_API_KEY === 'string') {
      const creds: StoredCredentials = {
        type: 'api_key',
        access: codexData.OPENAI_API_KEY,
      };
      await this.saveCredentials(creds);
      this.cachedCredentials = creds;
      this.cachedBridgeAuth = this.toBridgeAuth(creds) ?? null;
      this.cachedApiKey = creds.access ?? '';
      logger.info('AnthropicToCodexBridgeProvider: imported API key from ~/.codex/auth.json');
      return;
    }

    // Case 2: OAuth tokens.
    if (!codexData.tokens?.access_token) return;

    let accessToken = codexData.tokens.access_token;
    let refreshToken = codexData.tokens.refresh_token;
    let expires: number | undefined;

    if (refreshToken) {
      // Prefer a fresh token before importing; if refresh fails, still import
      // existing tokens so NeoKai remains decoupled from ~/.codex/auth.json.
      const refreshed = await this.tryRefreshCodexToken(refreshToken);
      if (refreshed.ok) {
        accessToken = refreshed.token.access_token;
        refreshToken = refreshed.token.refresh_token || refreshToken;
        expires = Date.now() + refreshed.token.expires_in * 1000;
        logger.info(
          'AnthropicToCodexBridgeProvider: imported refreshed OAuth token from ~/.codex/auth.json'
        );
      } else {
        logger.warn(
          'AnthropicToCodexBridgeProvider: Codex token refresh failed; importing existing ~/.codex/auth.json token'
        );
      }
    }

    const creds: StoredCredentials = {
      type: 'oauth',
      access: accessToken,
      refresh: refreshToken,
      expires,
      accountId: this.extractAccountId(accessToken) ?? codexData.tokens.account_id,
      planType: this.extractPlanType(accessToken),
      isFedrampAccount:
        this.extractIsFedrampAccount(codexData.tokens.id_token) ??
        this.extractIsFedrampAccount(accessToken),
    };
    await this.saveCredentials(creds);
    this.cachedCredentials = creds;
    this.cachedBridgeAuth = this.toBridgeAuth(creds) ?? null;
    this.cachedApiKey = creds.access ?? '';
    logger.info('AnthropicToCodexBridgeProvider: imported OAuth token from ~/.codex/auth.json');
  }

  /**
   * Attempt to refresh a Codex/OpenAI OAuth token.
   * Delegates to the exported module-level refreshCodexToken() function.
   */
  private tryRefreshCodexToken(refreshToken: string): Promise<CodexRefreshResult> {
    return refreshCodexToken(refreshToken);
  }

  // -------------------------------------------------------------------------
  // Private: PKCE helpers
  // -------------------------------------------------------------------------

  private generateRandomString(length: number): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const randomValues = crypto.randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars[randomValues[i] % chars.length];
    }
    return result;
  }

  private async generatePKCEChallenge(verifier: string): Promise<string> {
    return crypto.createHash('sha256').update(verifier).digest().toString('base64url');
  }

  private parseTokenPayload(accessToken: string): Record<string, unknown> | undefined {
    try {
      const parts = accessToken.split('.');
      if (parts.length !== 3) return undefined;
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<
        string,
        unknown
      >;
    } catch {
      return undefined;
    }
  }

  private extractAccountId(accessToken: string): string | undefined {
    const payload = this.parseTokenPayload(accessToken);
    if (!payload) return undefined;
    const auth = payload['https://api.openai.com/auth'] as Record<string, string> | undefined;
    return auth?.chatgpt_account_id ?? (payload.sub as string | undefined);
  }

  private extractPlanType(accessToken: string): string | undefined {
    const payload = this.parseTokenPayload(accessToken);
    if (!payload) return undefined;
    const auth = payload['https://api.openai.com/auth'] as Record<string, string> | undefined;
    return auth?.chatgpt_plan_type;
  }

  private booleanClaim(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return undefined;
  }

  private extractIsFedrampAccount(
    tokenOrPayload: string | Record<string, unknown> | undefined
  ): boolean | undefined {
    const payload =
      typeof tokenOrPayload === 'string' ? this.parseTokenPayload(tokenOrPayload) : tokenOrPayload;
    if (!payload) return undefined;

    const auth = payload['https://api.openai.com/auth'];
    const authRecord =
      auth && typeof auth === 'object' && !Array.isArray(auth)
        ? (auth as Record<string, unknown>)
        : undefined;

    return (
      this.booleanClaim(authRecord?.is_fedramp_account) ??
      this.booleanClaim(authRecord?.isFedrampAccount) ??
      this.booleanClaim(authRecord?.fedramp) ??
      this.booleanClaim(payload.is_fedramp_account) ??
      this.booleanClaim(payload.isFedrampAccount) ??
      this.booleanClaim(payload.fedramp)
    );
  }
}

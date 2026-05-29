/**
 * Anthropic Copilot Provider
 *
 * A NeoKai provider that starts an embedded Anthropic-compatible HTTP server
 * backed by the `@github/copilot-sdk`.  The Claude Agent SDK is pointed at
 * this server via `ANTHROPIC_BASE_URL`, so Copilot becomes a fully native SDK
 * backend — multi-turn, streaming, and tool use — with no custom generator
 * bridging.
 *
 * ## How it works
 *
 * The embedded server implements the Anthropic messages API (`POST /v1/messages`).
 * Incoming tool definitions are registered as Copilot SDK external tools.
 * When the Copilot model decides to call one of them the server emits an
 * Anthropic `tool_use` SSE block, ends the response, and suspends the session.
 * The next request (with `tool_result`) resumes the session via the
 * `ConversationManager`.
 *
 * ## Authentication
 *
 * **Runtime availability** (`isAvailable()`, sources 1–5 via `resolveGitHubToken()`):
 * Controls whether models are listed and sessions can be created.
 *   1. `~/.neokai/auth.json` (explicitly stored NeoKai credentials)
 *   2. `COPILOT_GITHUB_TOKEN` env var (PAT with copilot_requests scope)
 *   3. `GH_TOKEN` env var
 *   4. `gh auth token` CLI output
 *   5. `~/.config/gh/hosts.yml` oauth_token
 * Sources 2–5 allow the daemon and CI tests to use external credentials for API
 * calls without going through the NeoKai login flow.
 *
 * **UI auth check** (`getAuthStatus()`, source 1 only):
 * `getAuthStatus()` checks only `~/.neokai/auth.json`. This is what drives the
 * Login/Logout buttons. Env-var and external credentials return `isAuthenticated: false`
 * so the Logout button only appears when NeoKai can actually remove the token.
 *
 * IMPORTANT: `GITHUB_TOKEN` (GitHub Actions token) is NOT used — it lacks
 * Copilot access and causes "Not logged in" errors.
 *
 * ## Embedded server lifecycle
 *
 * The server is created lazily on the first `buildSdkConfig()` call and reused
 * for the lifetime of the provider instance (i.e. the daemon process).  It
 * binds to `127.0.0.1:0` (OS-assigned port) and is never reachable from
 * outside the host.
 */

import type {
  Provider,
  ProviderCapabilities,
  ProviderSdkConfig,
  ProviderSessionConfig,
  ModelTier,
  ProviderAuthStatusInfo,
  ProviderCredentials,
  ProviderOAuthFlowData,
} from '@neokai/shared/provider';
import type { ModelInfo } from '@neokai/shared';
import { CopilotClient, type ModelInfo as CopilotSdkModelInfo } from '@github/copilot-sdk';
import { startEmbeddedServer, type EmbeddedServer } from './server.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Logger } from '../../logger.js';
import { buildCopilotEnv } from './bun-node-wrapper.js';

const execFileAsync = promisify(execFile);
const logger = new Logger('anthropic-copilot-provider');

/**
 * Pick the most appropriate model from `models` for a given tier.
 *
 * Used by getModelForTier() when the static fallback ID is not in the dynamic
 * model list.  Prefers models whose ID or name contains keywords associated
 * with the tier; falls back to the first available model.
 */
function pickModelForTier(models: ModelInfo[], tier: ModelTier): string | undefined {
  if (models.length === 0) return undefined;
  const available = models.filter((m) => m.available !== false);
  if (available.length === 0) return undefined;

  const keywordsByTier: Record<ModelTier, string[]> = {
    opus: ['opus', 'pro', 'ultra'],
    // 'flash' is intentionally absent from sonnet — Gemini Flash models are fast/cheap
    // and should be haiku-tier. Including 'flash' here would shadow the haiku path
    // whenever a Flash model appears in the account's model list.
    sonnet: ['sonnet', '4o', 'turbo'],
    haiku: ['mini', 'haiku', 'flash', 'fast', 'lite'],
    // 'default' mirrors 'sonnet': a mid-tier capable model is the right default.
    default: ['sonnet', '4o', 'turbo'],
  };
  const keywords = keywordsByTier[tier] ?? [];
  for (const kw of keywords) {
    const match = available.find((m) => m.id.toLowerCase().includes(kw));
    if (match) return match.id;
  }
  // Fall back to first available model.
  return available[0].id;
}

/**
 * Infer the model family from a Copilot SDK model ID.
 * Returns 'sonnet', 'opus', 'haiku', 'gpt', or 'gemini'.
 */
function inferModelFamily(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.includes('claude')) {
    if (id.includes('opus')) return 'opus';
    if (id.includes('haiku')) return 'haiku';
    return 'sonnet';
  }
  if (id.includes('gemini')) return 'gemini';
  return 'gpt';
}

/**
 * Static fallback model definitions for the Copilot provider.
 *
 * These are used as display-name / alias enrichment when building the model list
 * from `client.listModels()`. They also serve as a last-resort fallback if the
 * Copilot API is unreachable at the time `getModels()` is called.
 *
 * IMPORTANT — Do NOT rely on these IDs being valid for the user's Copilot account.
 * The actual available models are fetched dynamically via `client.listModels()` so
 * that the test model ID matches what the Copilot API actually accepts.
 *
 * NOTE — intentional model ID collision with the Anthropic provider:
 * The `id` fields below (e.g. `claude-opus-4.6`) may also be claimed by the
 * Anthropic provider. Every `anthropic-copilot` session stores its provider ID
 * explicitly in `session.config.provider` to avoid ambiguity.
 */
const COPILOT_ANTHROPIC_MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-4.6',
    name: 'Claude Opus 4.6 (Copilot)',
    alias: 'copilot-anthropic-opus',
    family: 'opus',
    provider: 'anthropic-copilot',
    contextWindow: 200000,
    description: 'Claude Opus 4.6 via GitHub Copilot · Native Claude Agent SDK',
    releaseDate: '2025-11-01',
    available: true,
  },
  {
    id: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6 (Copilot)',
    alias: 'copilot-anthropic-sonnet',
    family: 'sonnet',
    provider: 'anthropic-copilot',
    contextWindow: 200000,
    description: 'Claude Sonnet 4.6 via GitHub Copilot · Native Claude Agent SDK',
    releaseDate: '2025-11-01',
    available: true,
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex (Copilot)',
    alias: 'copilot-anthropic-codex',
    family: 'gpt',
    provider: 'anthropic-copilot',
    contextWindow: 272000,
    description: 'GPT-5.3 Codex via GitHub Copilot · Best for coding',
    releaseDate: '2025-12-01',
    available: true,
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4 (Copilot)',
    alias: 'copilot-anthropic-gpt-5.4',
    family: 'gpt',
    provider: 'anthropic-copilot',
    contextWindow: 272000,
    description: 'GPT-5.4 via GitHub Copilot',
    releaseDate: '2026-01-01',
    available: true,
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5 (Copilot)',
    alias: 'copilot-anthropic-gpt-5.5',
    family: 'gpt',
    provider: 'anthropic-copilot',
    contextWindow: 272000,
    description: 'GPT-5.5 via GitHub Copilot',
    releaseDate: '2026-04-01',
    available: true,
  },
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro (Copilot)',
    alias: 'copilot-anthropic-gemini',
    family: 'gemini',
    provider: 'anthropic-copilot',
    contextWindow: 128000,
    description: 'Gemini 3.1 Pro Preview via GitHub Copilot',
    releaseDate: '2025-11-15',
    available: true,
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 Mini (Copilot)',
    alias: 'copilot-anthropic-mini',
    family: 'gpt',
    provider: 'anthropic-copilot',
    contextWindow: 128000,
    description: 'GPT-5 Mini via GitHub Copilot · Fast and efficient',
    releaseDate: '2025-12-01',
    available: true,
  },
];

/**
 * Stored credentials format for GitHub Copilot in ~/.neokai/auth.json
 */
interface StoredCopilotCredentials {
  /** The GitHub OAuth access token (used as the Copilot session token). */
  refresh: string;
  enterpriseUrl?: string;
}

/**
 * OAuth device flow response
 */
interface DeviceFlowResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/** Resolved-token cache entry (5-minute TTL). */
interface TokenCacheEntry {
  token: string | undefined;
  expiresAt: number;
}

const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

export class AnthropicToCopilotBridgeProvider implements Provider {
  readonly id = 'anthropic-copilot';
  readonly displayName = 'GitHub Copilot (Anthropic API)';

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    // Extended thinking is not supported by the Copilot SDK. The SDK's createSession()
    // and send() methods have no thinking-related options (no 'betas', no 'thinking' param),
    // and the SSE events contain no thinking_delta events. GitHub Copilot's API does not
    // expose Claude's extended thinking capability.
    extendedThinking: false,
    thinkingModes: 'off',
    maxContextWindow: 272000,
    /**
     * Full tool-use support: the embedded server registers incoming `tools`
     * as Copilot SDK external tools and bridges tool_use / tool_result across
     * consecutive HTTP requests via ConversationManager.
     */
    functionCalling: true,
    vision: false,
  };

  /** Singleton CopilotClient, created lazily */
  private clientCache: CopilotClient | undefined = undefined;
  /** Singleton embedded server, started lazily */
  private serverCache: EmbeddedServer | undefined = undefined;
  /** In-flight server start promise (prevents race on concurrent first calls) */
  private serverStarting: Promise<EmbeddedServer> | undefined = undefined;
  /** Resolved token cache with TTL */
  private tokenCache: TokenCacheEntry | null = null;
  private storedCredentialToken: string | null = null;
  private readonly credentialListeners = new Set<
    (credentials: ProviderCredentials) => void | Promise<void>
  >();
  /**
   * Dynamically fetched models from the Copilot API (via client.listModels()).
   * Populated in getModels() and used by ownsModel()/getModelForTier() so that
   * real Copilot model IDs (which may differ from our static list) are recognised
   * by this provider.
   *
   * NOTE — ownsModel() call-order dependency:
   * ownsModel() checks this cache but cannot populate it (the method is synchronous
   * while listModels() is async). In the normal lifecycle getModels() is always
   * called before a session is created (the UI fetches models before offering them
   * to the user), so the cache is populated before ownsModel() is needed for routing.
   * Sessions resumed from a restart are looked up via the stored explicit providerId
   * (registry.detectProviderForModel), so ownsModel() is not on the critical path
   * for those.  If ownsModel() is called before getModels() for a real Copilot SDK
   * model ID that is not in the static list, it will return false — a known
   * limitation documented here.
   */
  private dynamicModelsCache: ModelInfo[] | null = null;
  /** Expiry timestamp for dynamicModelsCache (epoch ms). 0 means "not set". */
  private dynamicModelsCacheExpiresAt = 0;

  /** Path to stored authentication tokens */
  private readonly authPath: string;

  /** Active OAuth device flow state */
  private activeOAuthFlow: {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresAt: number;
    completed: boolean;
    success: boolean;
  } | null = null;

  constructor(
    /** Working directory for Copilot sessions — defaults to `process.cwd()` at construction time. */
    private readonly cwd: string = process.cwd(),
    private readonly env: NodeJS.ProcessEnv = process.env,
    authDir?: string
  ) {
    this.authPath = path.join(authDir || path.join(os.homedir(), '.neokai'), 'auth.json');
  }

  setCredentials(credentials: ProviderCredentials): void {
    const token =
      credentials.type === 'api_key'
        ? credentials.apiKey
        : (credentials.accessToken ?? credentials.refreshToken);
    if (!token) return;
    this.storedCredentialToken = token;
    this.tokenCache = { token, expiresAt: Number.POSITIVE_INFINITY };
  }

  async getCredentials(): Promise<ProviderCredentials | null> {
    const token = this.storedCredentialToken ?? this.tokenCache?.token;
    if (token) return { type: 'oauth', accessToken: token };

    // Read from auth file so startup reconciliation sees fresh provider-owned
    // credentials before applying stale credential-manager rows.
    const fileToken = await this.loadStoredGitHubToken();
    if (fileToken) return { type: 'oauth', accessToken: fileToken };

    return null;
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

  async isAvailable(): Promise<boolean> {
    // Use full credential discovery (env vars, auth.json, gh CLI, hosts.yml) so models
    // are listed and sessions work regardless of how credentials were provisioned.
    // getAuthStatus() is the UI-only check that restricts Login/Logout to auth.json OAuth.
    const token = await this.resolveGitHubToken();
    if (!token || token.startsWith('ghp_')) return false;
    return true;
  }

  async getModels(): Promise<ModelInfo[]> {
    // isAvailable() uses the full credential discovery chain so model listing works
    // for env-var users and CI without requiring NeoKai-managed OAuth.
    if (!(await this.isAvailable())) return [];
    // Pre-warm the embedded server so buildSdkConfig() has a valid URL by
    // the time the user picks a model and starts a session.
    try {
      await this.ensureServerStarted();
    } catch (err) {
      logger.error('Failed to start embedded Anthropic server:', err);
      return [];
    }

    // Fetch real model IDs from the Copilot API so we only expose models that
    // the user's account can actually use.  Hardcoded model IDs are used as
    // display-name / context-window enrichment when a match is found, and as a
    // last-resort fallback when the API call fails.
    // The result is cached with a TTL matching the token cache (5 minutes) to
    // avoid making a listModels() API call on every model-list request.
    const now = Date.now();
    if (this.dynamicModelsCache && now < this.dynamicModelsCacheExpiresAt) {
      return this.dynamicModelsCache;
    }

    if (this.clientCache) {
      try {
        const sdkModels = await this.clientCache.listModels();
        const mapped = sdkModels
          .filter((m) => m.policy?.state !== 'disabled')
          .map((m) => this.mapCopilotSdkModel(m));
        if (mapped.length > 0) {
          this.dynamicModelsCache = mapped;
          this.dynamicModelsCacheExpiresAt = now + TOKEN_CACHE_TTL_MS;
          return mapped;
        }
      } catch (err) {
        logger.warn('client.listModels() failed, falling back to static model list:', err);
      }
    }

    return COPILOT_ANTHROPIC_MODELS;
  }

  ownsModel(modelId: string): boolean {
    if (COPILOT_ANTHROPIC_MODELS.some((m) => m.alias === modelId || m.id === modelId)) {
      return true;
    }
    // Also check dynamically fetched models (real Copilot SDK model IDs).
    if (this.dynamicModelsCache) {
      return this.dynamicModelsCache.some((m) => m.alias === modelId || m.id === modelId);
    }
    return false;
  }

  getModelForTier(tier: ModelTier): string | undefined {
    const tierMap: Record<ModelTier, string> = {
      opus: 'claude-opus-4.6',
      sonnet: 'claude-sonnet-4.6',
      haiku: 'gpt-5-mini',
      default: 'claude-sonnet-4.6',
    };
    const staticId = tierMap[tier];

    // If the dynamic cache is populated, prefer a model from it to avoid
    // returning an ID that does not exist on the user's Copilot account.
    const cache = this.dynamicModelsCache;
    if (cache && cache.length > 0) {
      // 1. Static ID is in the cache → it is a real Copilot model, use it.
      if (cache.some((m) => m.id === staticId || m.alias === staticId)) {
        return staticId;
      }
      // 2. Find the best matching model in the cache for this tier.
      const preferred = pickModelForTier(cache, tier);
      if (preferred) return preferred;
    }

    return staticId;
  }

  /**
   * Build SDK configuration for this provider.
   *
   * Returns env vars that point the Claude Agent SDK at the embedded server:
   * - `ANTHROPIC_BASE_URL`        → `http://127.0.0.1:<port>`
   * - `ANTHROPIC_AUTH_TOKEN`      → workspace path encoded for the server
   * - `ANTHROPIC_DEFAULT_*_MODEL` → maps SDK tiers to Copilot model IDs
   *
   * **Precondition:** `getModels()` (or `ensureServerStarted()`) must be
   * awaited before calling this method.
   */
  buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    if (!this.serverCache) {
      throw new Error(
        'AnthropicToCopilotBridgeProvider: embedded server not started. ' +
          'Await getModels() or ensureServerStarted() before calling buildSdkConfig().'
      );
    }

    const allKnownModels = this.dynamicModelsCache ?? COPILOT_ANTHROPIC_MODELS;
    const entry = allKnownModels.find((m) => m.alias === modelId || m.id === modelId);
    const resolvedId = entry?.id ?? modelId;
    // Per-session workspace path is encoded in the auth token so the embedded
    // server (shared singleton) can apply the correct cwd per HTTP request.
    const workspacePath = (sessionConfig?.workspacePath as string | undefined) ?? this.cwd;

    return {
      envVars: {
        ANTHROPIC_BASE_URL: this.serverCache.url,
        ANTHROPIC_AUTH_TOKEN: `anthropic-copilot-proxy:${workspacePath}`,
        // Clear the real Anthropic API key so the SDK subprocess does not bypass
        // the embedded proxy and call api.anthropic.com directly.
        // Auth is provided via ANTHROPIC_AUTH_TOKEN (the workspace-encoded proxy token).
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        API_TIMEOUT_MS: '300000',
        // All three tiers route to the same resolved model so the bridge handles
        // every SDK-internal model request with the one real Copilot model ID.
        ANTHROPIC_DEFAULT_OPUS_MODEL: resolvedId,
        ANTHROPIC_DEFAULT_SONNET_MODEL: resolvedId,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: resolvedId,
      },
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  /**
   * Get current authentication status.
   * Only NeoKai-managed credentials (auth.json) are considered authenticated.
   * Env vars and external sources (gh CLI, hosts.yml) are for daemon/test use only.
   */
  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    try {
      const token = this.storedCredentialToken ?? (await this.loadStoredGitHubToken());
      if (!token) {
        return {
          isAuthenticated: false,
          error: 'Not logged in. Click Login to authenticate with GitHub Copilot.',
        };
      }
      // Classic PATs (ghp_) are explicitly rejected by the Copilot CLI internals.
      if (token.startsWith('ghp_')) {
        return {
          isAuthenticated: false,
          error:
            'Classic PATs (ghp_…) are not supported by the GitHub Copilot CLI. ' +
            'Use a fine-grained PAT with Copilot access, or run the OAuth login flow.',
        };
      }
      return { isAuthenticated: true, needsRefresh: false };
    } catch (error) {
      return {
        isAuthenticated: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Start OAuth device flow for authentication.
   *
   * Returns immediately with user code and verification URL.
   * The background polling stores the token in ~/.neokai/auth.json on success.
   */
  async startOAuthFlow(): Promise<ProviderOAuthFlowData> {
    if (this.activeOAuthFlow && !this.activeOAuthFlow.completed) {
      return {
        type: 'device',
        userCode: this.activeOAuthFlow.userCode,
        verificationUri: this.activeOAuthFlow.verificationUri,
        message: 'OAuth flow already in progress. Enter the code at the verification URL.',
      };
    }

    try {
      const enterpriseDomain = this.getEnterpriseDomain();
      const deviceResponse = await this.startDeviceFlow(enterpriseDomain);

      this.activeOAuthFlow = {
        deviceCode: deviceResponse.device_code,
        userCode: deviceResponse.user_code,
        verificationUri: deviceResponse.verification_uri,
        expiresAt: Date.now() + deviceResponse.expires_in * 1000,
        completed: false,
        success: false,
      };

      this.startBackgroundPolling(deviceResponse, enterpriseDomain).catch((error) => {
        logger.error('Background polling failed:', error);
        if (this.activeOAuthFlow) {
          this.activeOAuthFlow.completed = true;
          this.activeOAuthFlow.success = false;
        }
      });

      return {
        type: 'device',
        userCode: deviceResponse.user_code,
        verificationUri: deviceResponse.verification_uri,
        message: 'Enter the code at the verification URL to authenticate.',
      };
    } catch (error) {
      logger.error('Failed to start OAuth flow:', error);
      throw error;
    }
  }

  /**
   * Logout — remove stored GitHub Copilot credentials from ~/.neokai/auth.json.
   */
  async logout(): Promise<void> {
    // Invalidate token cache
    this.storedCredentialToken = null;
    this.tokenCache = null;

    try {
      const content = await fs.readFile(this.authPath, 'utf-8');
      const data = JSON.parse(content) as Record<string, unknown>;
      delete data['github-copilot'];

      if (Object.keys(data).length === 0) {
        await fs.unlink(this.authPath);
      } else {
        await fs.writeFile(this.authPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      }
    } catch {
      // Ignore if file doesn't exist
    }
  }

  /**
   * Shut down the embedded HTTP server and the underlying CopilotClient subprocess.
   *
   * **Call after `sessionManager.cleanup()`** — active NeoKai sessions hold
   * open SSE connections to this server; they must be closed first.
   */
  async shutdown(): Promise<void> {
    if (this.serverCache) {
      await this.serverCache.stop().catch((err: unknown) => {
        logger.warn('Error stopping embedded Anthropic server:', err);
      });
      this.serverCache = undefined;
    }
    if (this.clientCache) {
      await this.clientCache.stop().catch((err: unknown) => {
        logger.warn('Error stopping CopilotClient:', err);
      });
      this.clientCache = undefined;
    }
  }

  /**
   * Pre-warm: start the embedded server and return its URL.
   * Safe to call concurrently — only one server is ever created.
   */
  async ensureServerStarted(): Promise<string> {
    if (this.serverCache) return this.serverCache.url;

    if (!this.serverStarting) {
      this.serverStarting = this.createServer();
    }

    try {
      this.serverCache = await this.serverStarting;
      this.serverStarting = undefined;
    } catch (err) {
      this.serverStarting = undefined;
      throw err;
    }
    return this.serverCache.url;
  }

  // ---------------------------------------------------------------------------
  // Credential discovery chain
  // ---------------------------------------------------------------------------

  /**
   * Resolve a GitHub OAuth token using this priority order:
   *   1. ~/.neokai/auth.json (explicitly stored NeoKai credentials)
   *   2. COPILOT_GITHUB_TOKEN env var (PAT with copilot_requests scope)
   *   3. GH_TOKEN env var
   *   4. `gh auth token` CLI command
   *   5. ~/.config/gh/hosts.yml oauth_token
   *
   * IMPORTANT: GITHUB_TOKEN (GitHub Actions token) is NOT used — it lacks
   * Copilot access and causes "Not logged in" errors.
   *
   * Tokens from sources 4 and 5 are validated via a lightweight Copilot API
   * check before being returned. The result is cached for TOKEN_CACHE_TTL_MS.
   */
  private async resolveGitHubToken(): Promise<string | undefined> {
    if (this.storedCredentialToken) {
      return this.storedCredentialToken;
    }

    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.token;
    }

    const token = await this.discoverGitHubToken();
    this.tokenCache = { token, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS };
    return token;
  }

  private async discoverGitHubToken(): Promise<string | undefined> {
    // 1. ~/.neokai/auth.json
    const stored = await this.loadStoredGitHubToken();
    if (stored) return stored;

    // 2. COPILOT_GITHUB_TOKEN env var (explicit, has copilot_requests scope)
    if (this.env.COPILOT_GITHUB_TOKEN) return this.env.COPILOT_GITHUB_TOKEN;

    // 3. GH_TOKEN env var (user's gh CLI token)
    if (this.env.GH_TOKEN) return this.env.GH_TOKEN;

    // 4. gh auth token CLI
    const ghCliToken = await this.tryGhCliToken();
    if (ghCliToken) {
      const valid = await this.validateCopilotToken(ghCliToken);
      if (valid) return ghCliToken;
    }

    // 5. ~/.config/gh/hosts.yml
    const hostsToken = await this.tryGhHostsToken();
    if (hostsToken && hostsToken !== ghCliToken) {
      const valid = await this.validateCopilotToken(hostsToken);
      if (valid) return hostsToken;
    }

    return undefined;
  }

  /** Read GitHub OAuth token from ~/.neokai/auth.json */
  private async loadStoredGitHubToken(): Promise<string | undefined> {
    try {
      const content = await fs.readFile(this.authPath, 'utf-8');
      const data = JSON.parse(content) as Record<string, unknown>;
      const creds = data['github-copilot'] as StoredCopilotCredentials | undefined;
      if (creds?.refresh && typeof creds.refresh === 'string') {
        return creds.refresh;
      }
    } catch {
      // File doesn't exist or invalid JSON
    }
    return undefined;
  }

  /** Run `gh auth token` and return the token, or undefined on failure. */
  private async tryGhCliToken(): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 5000 });
      const token = stdout.trim();
      return token || undefined;
    } catch {
      return undefined;
    }
  }

  /** Read oauth_token from ~/.config/gh/hosts.yml */
  private async tryGhHostsToken(): Promise<string | undefined> {
    try {
      const hostsPath = path.join(os.homedir(), '.config', 'gh', 'hosts.yml');
      const content = await fs.readFile(hostsPath, 'utf-8');
      const match = content.match(/oauth_token:\s*(\S+)/);
      return match?.[1] || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Validate that a GitHub OAuth token has Copilot API access.
   *
   * Uses the SDK to attempt a real Copilot session. The CLI subprocess handles
   * the OAuth→session-token exchange internally when COPILOT_GITHUB_TOKEN is set
   * in its env. This gives a definitive answer: if the CLI can create a session,
   * the token has the required Copilot access.
   *
   * The GitHub Actions GITHUB_TOKEN has no Copilot access, so its session attempt
   * fails, preventing false-positive authentication in CI.
   *
   * Only called for tokens from `gh auth token` (source 4) and hosts.yml (source 5).
   * COPILOT_GITHUB_TOKEN and GH_TOKEN env-var tokens are trusted without validation.
   *
   * Cold-path only: called once per daemon restart per credential source, then cached
   * for 5 minutes by `resolveGitHubToken`. Expected latency: 3–15 s (subprocess spawn
   * + OAuth exchange). A 20 s hard timeout prevents indefinite hangs on slow networks.
   *
   * Uses `client.listModels()` for validation — a non-empty model list proves the
   * token has Copilot API access without depending on any specific model being
   * available on the user's plan.  This is intentionally model-agnostic: a user
   * on an enterprise plan with a different model catalogue should still be
   * authenticated correctly.
   */
  private async validateCopilotToken(token: string): Promise<boolean> {
    const TIMEOUT_MS = 20_000;
    const client = new CopilotClient({
      useStdio: true,
      logLevel: 'error',
      env: buildCopilotEnv({ ...this.env, COPILOT_GITHUB_TOKEN: token }),
    });
    try {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const models = await Promise.race([
        client.listModels(),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('validateCopilotToken timed out')),
            TIMEOUT_MS
          );
        }),
      ]);
      clearTimeout(timeoutHandle);
      return models.length > 0;
    } catch {
      return false;
    } finally {
      await client.stop().catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // OAuth device flow
  // ---------------------------------------------------------------------------

  private getEnterpriseDomain(): string | undefined {
    const apiUrl = this.env.GITHUB_API_URL;
    if (!apiUrl) return undefined;
    try {
      const url = new URL(apiUrl);
      if (url.hostname === 'api.github.com') return undefined;
      return url.hostname;
    } catch {
      return undefined;
    }
  }

  private getGitHubOAuthUrl(enterpriseDomain?: string): string {
    return enterpriseDomain ? `https://${enterpriseDomain}` : 'https://github.com';
  }

  private getClientId(): string {
    // 'Iv1.b507a08c87ecfe98' is the public GitHub OAuth client ID used by the
    // official GitHub Copilot Chat VS Code extension (publicly listed at
    // https://github.com/settings/connections/applications/Iv1.b507a08c87ecfe98).
    // Using it here follows the same pattern as other open-source Copilot clients
    // (e.g. copilot.vim, CopilotChat.nvim).  Set GITHUB_COPILOT_CLIENT_ID to
    // override with a custom OAuth app client ID.
    return this.env.GITHUB_COPILOT_CLIENT_ID || 'Iv1.b507a08c87ecfe98';
  }

  private async startDeviceFlow(enterpriseDomain?: string): Promise<DeviceFlowResponse> {
    const clientId = this.getClientId();
    const githubOAuthUrl = this.getGitHubOAuthUrl(enterpriseDomain);

    const response = await fetch(`${githubOAuthUrl}/login/device/code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'GitHubCopilotChat/0.35.0',
      },
      body: JSON.stringify({ client_id: clientId, scope: 'read:user copilot' }),
    });

    if (!response.ok) {
      throw new Error(`Device flow start failed: ${response.statusText}`);
    }

    return response.json() as Promise<DeviceFlowResponse>;
  }

  private async startBackgroundPolling(
    device: DeviceFlowResponse,
    enterpriseDomain?: string
  ): Promise<void> {
    const clientId = this.getClientId();
    const githubOAuthUrl = this.getGitHubOAuthUrl(enterpriseDomain);
    const startTime = Date.now();
    const expiresMs = device.expires_in * 1000;
    // Mutable polling interval: slow_down responses require adding 5 s (RFC 8628 §3.5)
    let pollIntervalSec = device.interval;

    while (Date.now() - startTime < expiresMs) {
      if (!this.activeOAuthFlow || this.activeOAuthFlow.completed) return;

      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollIntervalSec * 1000);
        // Allow the process to exit naturally if the daemon shuts down mid-flow.
        t.unref();
      });

      try {
        const response = await fetch(`${githubOAuthUrl}/login/oauth/access_token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            client_id: clientId,
            device_code: device.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        });

        if (!response.ok) continue;

        const data = (await response.json()) as {
          access_token?: string;
          error?: string;
        };

        if (data.error === 'authorization_pending') continue;

        // RFC 8628 §3.5: slow_down means back off by 5 s and retry — NOT a terminal error.
        if (data.error === 'slow_down') {
          pollIntervalSec += 5;
          continue;
        }

        if (data.error) {
          logger.error('OAuth polling error:', data.error);
          if (this.activeOAuthFlow) {
            this.activeOAuthFlow.completed = true;
            this.activeOAuthFlow.success = false;
          }
          return;
        }

        if (!data.access_token) continue;

        // Store the GitHub OAuth token directly — @github/copilot-sdk
        // handles the Copilot session token exchange internally.
        const credentials: StoredCopilotCredentials = {
          refresh: data.access_token,
          enterpriseUrl: enterpriseDomain,
        };

        await this.saveCredentials(credentials);
        // Invalidate token cache so next call picks up the new token
        this.storedCredentialToken = null;
        this.tokenCache = null;
        this.notifyCredentialsChanged({ type: 'oauth', accessToken: data.access_token });

        logger.debug('GitHub Copilot OAuth login successful');

        if (this.activeOAuthFlow) {
          this.activeOAuthFlow.completed = true;
          this.activeOAuthFlow.success = true;
        }
        return;
      } catch (error) {
        logger.debug('OAuth polling attempt failed:', error);
        continue;
      }
    }

    logger.error('OAuth device flow timed out');
    if (this.activeOAuthFlow) {
      this.activeOAuthFlow.completed = true;
      this.activeOAuthFlow.success = false;
    }
  }

  private async saveCredentials(credentials: StoredCopilotCredentials): Promise<void> {
    const dir = path.dirname(this.authPath);
    await fs.mkdir(dir, { recursive: true });

    let data: Record<string, unknown> = {};
    try {
      const content = await fs.readFile(this.authPath, 'utf-8');
      data = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // File doesn't exist, start fresh
    }

    data['github-copilot'] = credentials;

    await fs.writeFile(this.authPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Map a Copilot SDK ModelInfo to NeoKai's ModelInfo format.
   *
   * Uses the static list for display-name and context-window enrichment when a
   * matching ID is found, so existing users with static aliases are not affected.
   */
  private mapCopilotSdkModel(m: CopilotSdkModelInfo): ModelInfo {
    // Look up static entry for enriched display metadata.
    const staticEntry = COPILOT_ANTHROPIC_MODELS.find((s) => s.id === m.id);
    const family = inferModelFamily(m.id);
    return {
      id: m.id,
      name: staticEntry?.name ?? `${m.name ?? m.id} (Copilot)`,
      alias: staticEntry?.alias ?? `copilot-${m.id.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`,
      family,
      provider: 'anthropic-copilot',
      contextWindow:
        staticEntry?.contextWindow ?? m.capabilities?.limits?.max_context_window_tokens ?? 128000,
      description: staticEntry?.description ?? `${m.name ?? m.id} via GitHub Copilot`,
      releaseDate: staticEntry?.releaseDate ?? '2025-01-01',
      available: m.policy?.state !== 'disabled',
    };
  }

  private async createServer(): Promise<EmbeddedServer> {
    const token = await this.resolveGitHubToken();
    const client = await this.getOrCreateClient(token);
    const server = await startEmbeddedServer(client, this.cwd);
    logger.debug(`Embedded Anthropic server started at ${server.url}`);
    return server;
  }

  private async getOrCreateClient(token?: string): Promise<CopilotClient> {
    if (this.clientCache === undefined) {
      // Pass the GitHub OAuth token as COPILOT_GITHUB_TOKEN in the subprocess env.
      // The CLI will exchange it for a Copilot session token internally.
      //
      // Do NOT use the `githubToken` option — that sets COPILOT_SDK_AUTH_TOKEN,
      // which expects a pre-exchanged session token (tid=... format), not a GitHub
      // OAuth token (ghp_/gho_). Passing an OAuth token there causes the CLI to
      // reject it with "OAuth token has expired".
      const env: NodeJS.ProcessEnv = { ...this.env };
      if (token) {
        env.COPILOT_GITHUB_TOKEN = token;
      }
      const client = new CopilotClient({
        useStdio: true,
        logLevel: 'error',
        env: buildCopilotEnv(env),
      });
      // start() must be called to establish the underlying CLI connection.
      // If it throws, the exception propagates and clientCache is left undefined,
      // so the next call to getOrCreateClient() creates a fresh instance.
      await client.start();
      this.clientCache = client;
      logger.debug('Created CopilotClient (bundled CLI path)');
    }
    return this.clientCache;
  }
}

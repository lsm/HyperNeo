import { getDataDir } from '../data-dir';
import type {
  Provider,
  ProviderCapabilities,
  ProviderCredentials,
  ProviderSdkConfig,
  ProviderSessionConfig,
  ModelTier,
  ProviderAuthStatusInfo,
  ProviderOAuthFlowData,
} from '@hyperneo/shared/provider';
import type { ModelInfo } from '@hyperneo/shared';
import { THINKING_LEVEL_TOKENS } from '@hyperneo/shared';
import {
  type OpenAIResponsesBridgeAuth,
  type OpenAIResponsesBridgeServer,
  createOpenAIResponsesBridgeServer,
} from './openai-responses-bridge/server.js';
import {
  getCodexBridgeModelInfos,
  CODEX_TO_SDK_MODEL,
  codexBackendContextWindow,
} from './codex-models.js';
import { Logger } from '../logger.js';
import { applyRecordedFailureToAuthStatus } from './provider-failure-store.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as crypto from 'crypto';

const logger = new Logger('anthropic-to-codex-bridge-provider');

const ANTHROPIC_CODEX_MODELS = getCodexBridgeModelInfos();

const OAUTH_CONFIG = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  redirectUri: 'http://localhost:1455/auth/callback',
  scope: 'openid profile email offline_access',
  callbackPort: 1455,
};

interface StoredCredentials {
  type: 'oauth' | 'api_key';
  access?: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
  planType?: string;
  isFedrampAccount?: boolean;
}

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

export class AnthropicToCodexBridgeProvider implements Provider {
  readonly id = 'anthropic-codex';
  readonly displayName = 'OpenAI (Codex)';

  get capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      extendedThinking: true,
      thinkingModes: 'granular',
      maxContextWindow: 1050000,
      functionCalling: true,
      vision: true,
    };
  }

  private readonly bridgeServers = new Map<string, OpenAIResponsesBridgeServer>();
  private readonly bridgeServerAuthKeys = new Map<string, string>();

  private readonly authPath: string;

  private readonly codexAuthPath: string;

  private cachedCredentials: StoredCredentials | null = null;
  private readonly credentialListeners = new Set<
    (credentials: ProviderCredentials) => void | Promise<void>
  >();

  private cachedBridgeAuth: OpenAIResponsesBridgeAuth | null | undefined = undefined;
  private cachedBridgeAuthMissExpiresAt = 0;

  private cachedApiKey: string | undefined = undefined;

  private activeOAuthFlow: {
    state: string;
    verifier: string;
    server: http.Server | null;
    completed: boolean;
    success: boolean;
  } | null = null;

  private readonly probeCache = new Map<string, { at: number; result: Promise<void> }>();
  private static readonly PROBE_TTL_MS = 30_000;
  private static readonly PROBE_TIMEOUT_MS = 5000;
  private static readonly NEGATIVE_AUTH_CACHE_TTL_MS = 5 * 60 * 1000;

  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    authDir?: string,
    codexAuthDir?: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.authPath = path.join(authDir ?? getDataDir(), 'auth.json');
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

  private async getBridgeAuth(): Promise<OpenAIResponsesBridgeAuth | undefined> {
    if (this.env.OPENAI_API_KEY) {
      return { source: 'api_key', apiKey: this.env.OPENAI_API_KEY };
    }

    if (this.cachedBridgeAuth !== undefined) {
      if (this.cachedBridgeAuth !== null || Date.now() < this.cachedBridgeAuthMissExpiresAt) {
        return this.cachedBridgeAuth ?? undefined;
      }
      this.cachedBridgeAuth = undefined;
    }

    const hyperneoCreds = await this.loadCredentials();
    if (hyperneoCreds?.access) {
      const auth = this.toBridgeAuth(hyperneoCreds);
      this.cachedBridgeAuth = auth ?? null;
      this.cachedApiKey = hyperneoCreds.access;
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
    this.cachedBridgeAuthMissExpiresAt =
      Date.now() + AnthropicToCodexBridgeProvider.NEGATIVE_AUTH_CACHE_TTL_MS;
    this.cachedApiKey = '';
    return undefined;
  }

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
    if (auth.source === 'api_key') {
      const hash = crypto.createHash('sha256').update(auth.apiKey).digest('hex').slice(0, 16);
      return `api_key:${hash}`;
    }
    return ['chatgpt', auth.accountId, auth.isFedrampAccount ? 'fedramp' : 'standard'].join(':');
  }

  private resolveBridgeAuth(): OpenAIResponsesBridgeAuth | undefined {
    const envAuth = this.env.OPENAI_API_KEY
      ? ({ source: 'api_key', apiKey: this.env.OPENAI_API_KEY } as const)
      : undefined;
    const fileAuth = this.cachedCredentials ? this.toBridgeAuth(this.cachedCredentials) : undefined;
    return envAuth ?? this.cachedBridgeAuth ?? fileAuth ?? undefined;
  }

  private modelAliases(): Record<string, string> {
    const userAliases = Object.fromEntries(
      ANTHROPIC_CODEX_MODELS.flatMap((model) => [
        ...(model.alias ? [[model.alias, model.id] as const] : []),
        ...(model.providerAliases?.map((alias) => [alias, model.id] as const) ?? []),
      ])
    );
    return userAliases;
  }

  private responsesBridgeModels(isChatgptOAuth: boolean) {
    const codexModels = ANTHROPIC_CODEX_MODELS.map((model) => ({
      id: model.id,
      display_name: model.name,
      created_at: `${model.releaseDate ?? '2026-01-01'}T00:00:00Z`,
      context_window: isChatgptOAuth
        ? (codexBackendContextWindow(model.id) ?? model.contextWindow)
        : model.contextWindow,
      max_tokens: model.id.startsWith('gpt-5.6-') ? 128000 : 16384,
    }));
    return codexModels;
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
    return applyRecordedFailureToAuthStatus(this.id, await this.resolveCredentialAuthStatus());
  }

  private async resolveCredentialAuthStatus(): Promise<ProviderAuthStatusInfo> {
    const hyperneoCreds = await this.loadCredentials();
    if (!hyperneoCreds || hyperneoCreds.type !== 'oauth') {
      return {
        isAuthenticated: false,
        error: hyperneoCreds
          ? 'API key credentials are not supported via the UI. Click Login to authenticate with OpenAI OAuth.'
          : 'Not logged in. Click Login to authenticate with OpenAI.',
      };
    }

    if (hyperneoCreds.expires) {
      const bufferMs = 5 * 60 * 1000;
      if (Date.now() >= hyperneoCreds.expires - bufferMs) {
        return {
          isAuthenticated: true,
          method: 'oauth',
          expiresAt: hyperneoCreds.expires,
          needsRefresh: true,
        };
      }
      return { isAuthenticated: true, method: 'oauth', expiresAt: hyperneoCreds.expires };
    }

    return { isAuthenticated: true, method: 'oauth' };
  }

  private async verifyCredentials(auth: OpenAIResponsesBridgeAuth): Promise<void> {
    const cacheKey = this.bridgeAuthCacheKey(auth);
    const cached = this.probeCache.get(cacheKey);
    if (cached && Date.now() - cached.at < AnthropicToCodexBridgeProvider.PROBE_TTL_MS) {
      await cached.result;
      return;
    }
    const result = this.probeUpstream(auth)
      .then(() => undefined)
      .catch((err) => {
        this.probeCache.delete(cacheKey);
        throw err;
      });
    this.probeCache.set(cacheKey, { at: Date.now(), result });
    await result;
  }

  private async probeUpstream(auth: OpenAIResponsesBridgeAuth): Promise<void> {
    const isChatgptOAuth = auth.source === 'chatgpt_oauth';
    const baseUrl = isChatgptOAuth
      ? 'https://chatgpt.com/backend-api/codex'
      : 'https://api.openai.com/v1';
    const url = `${baseUrl}/responses`;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${auth.apiKey}`,
    };
    if (isChatgptOAuth && auth.accountId) {
      headers['ChatGPT-Account-ID'] = auth.accountId;
    }

    const body: Record<string, unknown> = {
      model: 'gpt-5.4-mini',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '.' }],
        },
      ],
      stream: isChatgptOAuth,
    };
    if (isChatgptOAuth) {
      body.instructions = 'You are a concise assistant.';
      body.store = false;
    } else {
      body.max_output_tokens = 1;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(AnthropicToCodexBridgeProvider.PROBE_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(
          `Codex probe timed out after ${AnthropicToCodexBridgeProvider.PROBE_TIMEOUT_MS}ms`
        );
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Codex probe failed: ${detail}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(`Codex credentials rejected (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new Error(`Codex probe failed (HTTP ${response.status})`);
    }
    await response.body?.cancel().catch(() => undefined);
  }

  async getModels(): Promise<ModelInfo[]> {
    const auth = await this.getBridgeAuth();
    if (!auth) return [];
    await this.verifyCredentials(auth);
    return ANTHROPIC_CODEX_MODELS.map((m) => ({ ...m, thinkingModes: 'granular' as const }));
  }

  ownsModel(modelId: string): boolean {
    return ANTHROPIC_CODEX_MODELS.some(
      (m) => m.id === modelId || m.alias === modelId || m.providerAliases?.includes(modelId)
    );
  }

  translateModelIdForSdk(_modelId: string): string {
    return 'default';
  }

  getModelForTier(tier: ModelTier): string | undefined {
    const map: Record<ModelTier, string> = {
      opus: 'gpt-5.6-sol',
      sonnet: 'gpt-5.6-terra',
      haiku: 'gpt-5.6-luna',
      default: 'gpt-5.6-terra',
    };
    return map[tier];
  }

  buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    const sessionId = sessionConfig?.sessionId ?? 'default';
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
    const entry = ANTHROPIC_CODEX_MODELS.find(
      (m) => m.alias === modelId || m.id === modelId || m.providerAliases?.includes(modelId)
    );
    if (!entry) {
      throw new Error(`Unknown Codex model: ${modelId}`);
    }
    const resolvedId = entry.id;
    const isChatgptOAuth = auth?.source === 'chatgpt_oauth';

    if (!bridgeServer) {
      if (!auth) {
        logger.warn(
          'AnthropicToCodexBridgeProvider: starting Responses bridge without resolved auth; requests will fail until credentials are available'
        );
      }
      bridgeServer = createOpenAIResponsesBridgeServer({
        auth: auth ?? { source: 'api_key', apiKey: '' },
        models: this.responsesBridgeModels(isChatgptOAuth),
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

    const sdkModelId =
      CODEX_TO_SDK_MODEL[resolvedId as import('./codex-models.js').CodexBridgeModelId];
    if (!sdkModelId) {
      throw new Error(`Unknown Codex model: ${modelId}`);
    }

    bridgeServer.setSessionModelConfig?.(sessionId, sdkModelId, resolvedId);

    return {
      envVars: {
        ANTHROPIC_BASE_URL: bridgeBaseUrl,
        ANTHROPIC_API_KEY: `codex-bridge-${sessionId}`,
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(
          isChatgptOAuth
            ? (codexBackendContextWindow(resolvedId) ?? entry.contextWindow)
            : entry.contextWindow
        ),
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ANTHROPIC_DEFAULT_OPUS_MODEL: CODEX_TO_SDK_MODEL['gpt-5.6-sol'],
        ANTHROPIC_DEFAULT_SONNET_MODEL: sdkModelId,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: CODEX_TO_SDK_MODEL['gpt-5.6-luna'],
      },
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

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

  stopAllBridgeServers(): void {
    for (const server of this.bridgeServers.values()) {
      server.stop();
    }
    this.bridgeServers.clear();
    this.bridgeServerAuthKeys.clear();
    this.cachedCredentials = null;
    this.cachedBridgeAuth = undefined;
    this.cachedBridgeAuthMissExpiresAt = 0;
    this.cachedApiKey = undefined;
  }

  stopBridgeServer(): void {
    this.stopAllBridgeServers();
  }

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
          '<html><body><h1>Authentication successful!</h1><p>You can close this window and return to HyperNeo.</p><script>window.close();</script></body></html>'
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
    this.cachedBridgeAuthMissExpiresAt = 0;
    this.cachedApiKey = undefined;
    try {
      const content = await fs.readFile(this.authPath, 'utf-8');
      const data = JSON.parse(content) as Record<string, unknown>;
      delete data['openai'];

      if (Object.keys(data).length === 0) {
        await fs.unlink(this.authPath);
      } else {
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
    } catch {}
  }

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
    } catch {}
    return null;
  }

  private async saveCredentials(credentials: StoredCredentials): Promise<void> {
    const dir = path.dirname(this.authPath);
    await fs.mkdir(dir, { recursive: true });

    let data: Record<string, unknown> = {};
    try {
      const existing = await fs.readFile(this.authPath, 'utf-8');
      data = JSON.parse(existing) as Record<string, unknown>;
    } catch {}

    data['openai'] = credentials;
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

  private async importFromCodexAuth(): Promise<void> {
    let codexData: CodexAuthFile;
    try {
      const raw = await fs.readFile(this.codexAuthPath, 'utf-8');
      codexData = JSON.parse(raw) as CodexAuthFile;
    } catch {
      return;
    }

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

    if (!codexData.tokens?.access_token) return;

    let accessToken = codexData.tokens.access_token;
    let refreshToken = codexData.tokens.refresh_token;
    let expires: number | undefined;

    if (refreshToken) {
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

  private tryRefreshCodexToken(refreshToken: string): Promise<CodexRefreshResult> {
    return refreshCodexToken(refreshToken);
  }

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

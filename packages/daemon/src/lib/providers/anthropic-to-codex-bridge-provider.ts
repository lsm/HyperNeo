import { readFileSync } from 'node:fs';
import type { ModelInfo } from '@hyperneo/shared';
import { THINKING_LEVEL_TOKENS } from '@hyperneo/shared';
import type {
  ModelTier,
  Provider,
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderCredentials,
  ProviderOAuthFlowData,
  ProviderSdkConfig,
  ProviderSessionConfig,
} from '@hyperneo/shared/provider';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { getDataDir } from '../data-dir';
import { Logger } from '../logger.js';
import {
  CODEX_TO_SDK_MODEL,
  type CodexRemoteModelMetadata,
  codexBackendContextWindow,
  codexRemoteModelInfo,
  getCodexBridgeModelInfos,
  resolveCodexBridgeModelId,
} from './codex-models.js';
import {
  createOpenAIResponsesBridgeServer,
  type OpenAIResponsesBridgeAuth,
  type OpenAIResponsesBridgeServer,
} from './openai-responses-bridge/server.js';

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

type CodexModelVisibility = 'list' | 'hide' | 'none';

interface CodexRemoteModel extends CodexRemoteModelMetadata {
  visibility: CodexModelVisibility;
  supportedInApi: boolean;
  supportsReasoning: boolean;
  priority: number;
}

interface CodexModelCacheScope {
  source: 'api_key' | 'chatgpt_oauth';
  credentialId: string;
  accountId?: string;
  isFedrampAccount?: boolean;
}

interface CodexModelCache {
  schemaVersion: 2;
  fetchedAt: string;
  etag?: string;
  clientVersion: string;
  scope: CodexModelCacheScope;
  models: CodexRemoteModel[];
}

interface CodexCatalogEntry {
  info: ModelInfo;
  visibility: CodexModelVisibility;
}

const CODEX_MODEL_CACHE_SCHEMA_VERSION = 2;
const CODEX_MODEL_CACHE_TTL_MS = 300_000;
const CODEX_MODEL_FETCH_TIMEOUT_MS = 5000;
const CODEX_COMPAT_CLIENT_VERSION = '0.148.0';
const CODEX_MODEL_DISPLAY_NAME_MAX_LENGTH = 500;
const CODEX_MODEL_DESCRIPTION_MAX_LENGTH = 4000;

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

  private readonly authPath: string;

  private readonly codexAuthPath: string;

  private readonly modelCachePath: string;

  private catalogEntries: CodexCatalogEntry[] = this.bundledCatalogEntries();

  private modelCache: CodexModelCache | undefined;

  private hydratedCacheEntries: CodexCatalogEntry[] | undefined;

  private activeCatalogScope: CodexModelCacheScope | undefined;

  private readonly modelRefreshes = new Map<string, Promise<void>>();

  private readonly sessionModelIds = new Map<string, string>();

  private forceModelRefresh = false;

  private discoveryError: Error | undefined;

  private cachedCredentials: StoredCredentials | null = null;
  private readonly credentialListeners = new Set<
    (credentials: ProviderCredentials) => void | Promise<void>
  >();

  private cachedBridgeAuth: OpenAIResponsesBridgeAuth | null | undefined = undefined;

  private cachedApiKey: string | undefined = undefined;

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
    codexAuthDir?: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    const providerDir = authDir ?? getDataDir();
    this.authPath = path.join(providerDir, 'auth.json');
    this.codexAuthPath = path.join(codexAuthDir ?? path.join(os.homedir(), '.codex'), 'auth.json');
    this.modelCachePath = path.join(providerDir, 'openai-models-cache.json');
    this.loadModelCache();
    const auth = this.env.OPENAI_API_KEY
      ? ({ source: 'api_key', apiKey: this.env.OPENAI_API_KEY } as const)
      : this.loadBridgeAuthSync();
    if (auth) this.activateCachedCatalog(this.authScope(auth));
  }

  private loadBridgeAuthSync(): OpenAIResponsesBridgeAuth | undefined {
    try {
      const data = JSON.parse(readFileSync(this.authPath, 'utf-8')) as Record<string, unknown>;
      const credentials = data.openai as StoredCredentials | undefined;
      if (!credentials?.access) return undefined;
      this.cachedCredentials = credentials;
      this.cachedBridgeAuth = this.toBridgeAuth(credentials) ?? null;
      this.cachedApiKey = credentials.access;
      return this.cachedBridgeAuth ?? undefined;
    } catch {
      return undefined;
    }
  }

  private bundledCatalogEntries(): CodexCatalogEntry[] {
    return ANTHROPIC_CODEX_MODELS.map((info) => ({
      info: { ...info, thinkingModes: 'granular' },
      visibility: 'list',
    }));
  }

  private isModelId(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 256 &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
    );
  }

  private optionalPositiveInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? value
      : undefined;
  }

  private parseCachedRemoteModel(value: unknown): CodexRemoteModel | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (!this.isModelId(record.slug)) return undefined;
    if (typeof record.displayName !== 'string' || !record.displayName.trim()) return undefined;
    if (record.displayName.length > CODEX_MODEL_DISPLAY_NAME_MAX_LENGTH) return undefined;
    if (record.description !== undefined && typeof record.description !== 'string')
      return undefined;
    if (
      typeof record.description === 'string' &&
      record.description.length > CODEX_MODEL_DESCRIPTION_MAX_LENGTH
    )
      return undefined;
    if (!['list', 'hide', 'none'].includes(String(record.visibility))) return undefined;
    if (typeof record.supportedInApi !== 'boolean') return undefined;
    if (typeof record.supportsReasoning !== 'boolean') return undefined;
    if (typeof record.priority !== 'number' || !Number.isSafeInteger(record.priority))
      return undefined;
    const contextWindow = this.optionalPositiveInteger(record.contextWindow);
    const maxContextWindow = this.optionalPositiveInteger(record.maxContextWindow);
    if (record.contextWindow !== undefined && contextWindow === undefined) return undefined;
    if (record.maxContextWindow !== undefined && maxContextWindow === undefined) return undefined;
    return {
      slug: record.slug,
      displayName: record.displayName.trim(),
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxContextWindow ? { maxContextWindow } : {}),
      visibility: record.visibility as CodexModelVisibility,
      supportedInApi: record.supportedInApi,
      supportsReasoning: record.supportsReasoning,
      priority: record.priority,
    };
  }

  private parseModelCache(value: unknown): CodexModelCache | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== CODEX_MODEL_CACHE_SCHEMA_VERSION) return undefined;
    if (typeof record.fetchedAt !== 'string' || !Number.isFinite(Date.parse(record.fetchedAt))) {
      return undefined;
    }
    if (typeof record.clientVersion !== 'string') return undefined;
    if (record.etag !== undefined && typeof record.etag !== 'string') return undefined;
    if (!record.scope || typeof record.scope !== 'object' || Array.isArray(record.scope)) {
      return undefined;
    }
    const rawScope = record.scope as Record<string, unknown>;
    if (rawScope.source !== 'api_key' && rawScope.source !== 'chatgpt_oauth') return undefined;
    if (typeof rawScope.credentialId !== 'string' || !rawScope.credentialId) return undefined;
    if (rawScope.accountId !== undefined && typeof rawScope.accountId !== 'string')
      return undefined;
    if (rawScope.isFedrampAccount !== undefined && typeof rawScope.isFedrampAccount !== 'boolean') {
      return undefined;
    }
    if (!Array.isArray(record.models)) return undefined;
    const models = record.models.map((model) => this.parseCachedRemoteModel(model));
    if (models.length === 0 || models.some((model) => !model)) return undefined;
    return {
      schemaVersion: CODEX_MODEL_CACHE_SCHEMA_VERSION,
      fetchedAt: record.fetchedAt,
      ...(typeof record.etag === 'string' ? { etag: record.etag } : {}),
      clientVersion: record.clientVersion,
      scope: {
        source: rawScope.source,
        credentialId: rawScope.credentialId,
        ...(typeof rawScope.accountId === 'string' ? { accountId: rawScope.accountId } : {}),
        ...(typeof rawScope.isFedrampAccount === 'boolean'
          ? { isFedrampAccount: rawScope.isFedrampAccount }
          : {}),
      },
      models: models as CodexRemoteModel[],
    };
  }

  private loadModelCache(): void {
    try {
      const cache = this.parseModelCache(
        JSON.parse(readFileSync(this.modelCachePath, 'utf-8')) as unknown
      );
      if (!cache) return;
      const entries = this.catalogEntriesFromRemote(cache.models, cache.scope.source);
      if (!entries.some((entry) => entry.visibility === 'list')) return;
      this.modelCache = cache;
      this.hydratedCacheEntries = entries;
    } catch {
      return;
    }
  }

  private catalogEntriesFromRemote(
    models: CodexRemoteModel[],
    source: CodexModelCacheScope['source']
  ): CodexCatalogEntry[] {
    const bySlug = new Map<string, CodexRemoteModel>();
    for (const model of models) {
      if (source === 'api_key' && !model.supportedInApi) continue;
      const current = bySlug.get(model.slug);
      if (!current || model.priority < current.priority) bySlug.set(model.slug, model);
    }
    return [...bySlug.values()]
      .sort((a, b) => a.priority - b.priority || a.slug.localeCompare(b.slug))
      .map((model) => ({
        info: {
          ...codexRemoteModelInfo(model),
          thinkingModes: model.supportsReasoning ? 'granular' : 'off',
        },
        visibility: model.visibility,
      }));
  }

  private credentialId(auth: OpenAIResponsesBridgeAuth): string {
    return crypto.createHash('sha256').update(auth.apiKey).digest('hex');
  }

  private authScope(auth: OpenAIResponsesBridgeAuth): CodexModelCacheScope {
    return {
      source: auth.source,
      credentialId:
        auth.source === 'chatgpt_oauth'
          ? (auth.accountId ?? this.credentialId(auth))
          : this.credentialId(auth),
      ...(auth.source === 'chatgpt_oauth' ? { accountId: auth.accountId } : {}),
      ...(auth.source === 'chatgpt_oauth'
        ? { isFedrampAccount: auth.isFedrampAccount === true }
        : {}),
    };
  }

  private cacheMatchesScope(cache: CodexModelCache, scope: CodexModelCacheScope): boolean {
    return (
      cache.clientVersion === CODEX_COMPAT_CLIENT_VERSION &&
      cache.scope.source === scope.source &&
      cache.scope.credentialId === scope.credentialId &&
      cache.scope.accountId === scope.accountId &&
      cache.scope.isFedrampAccount === scope.isFedrampAccount
    );
  }

  private isModelCacheFresh(cache: CodexModelCache, scope: CodexModelCacheScope): boolean {
    return (
      this.cacheMatchesScope(cache, scope) &&
      Date.now() - Date.parse(cache.fetchedAt) < CODEX_MODEL_CACHE_TTL_MS
    );
  }

  private activateCachedCatalog(scope: CodexModelCacheScope): boolean {
    if (!this.modelCache || !this.hydratedCacheEntries) return false;
    if (!this.cacheMatchesScope(this.modelCache, scope)) return false;
    this.replaceCatalog(this.hydratedCacheEntries, scope);
    return true;
  }

  private hasActiveCatalog(scope: CodexModelCacheScope): boolean {
    return this.activeCatalogScope ? this.sameScope(this.activeCatalogScope, scope) : false;
  }

  private ensureCatalogForScope(scope: CodexModelCacheScope): void {
    if (!this.hasActiveCatalog(scope) && !this.activateCachedCatalog(scope)) {
      this.replaceCatalog(this.bundledCatalogEntries(), scope);
    }
  }

  private sameScope(left: CodexModelCacheScope, right: CodexModelCacheScope): boolean {
    return (
      left.source === right.source &&
      left.credentialId === right.credentialId &&
      left.accountId === right.accountId &&
      left.isFedrampAccount === right.isFedrampAccount
    );
  }

  private scopeKey(scope: CodexModelCacheScope): string {
    return [
      scope.source,
      scope.credentialId,
      scope.accountId ?? '',
      scope.isFedrampAccount ? 'fedramp' : 'standard',
    ].join(':');
  }

  private currentScopeMatches(scope: CodexModelCacheScope): boolean {
    const auth = this.resolveBridgeAuth();
    return auth ? this.sameScope(this.authScope(auth), scope) : false;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.getBridgeAuth()) !== undefined;
  }

  setCredentials(credentials: ProviderCredentials): void {
    if (credentials.type === 'api_key') {
      this.cachedCredentials = { type: 'api_key', access: credentials.apiKey };
      this.cachedBridgeAuth = { source: 'api_key', apiKey: credentials.apiKey };
      this.cachedApiKey = credentials.apiKey;
      this.ensureCatalogForScope(this.authScope(this.cachedBridgeAuth));
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
    if (this.cachedBridgeAuth) {
      this.ensureCatalogForScope(this.authScope(this.cachedBridgeAuth));
    }
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
      return this.cachedBridgeAuth ?? undefined;
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
    return Object.fromEntries(
      this.catalogEntries.flatMap(({ info }) => [
        ...(info.alias !== info.id ? [[info.alias, info.id] as const] : []),
        ...(info.providerAliases?.map((alias) => [alias, info.id] as const) ?? []),
      ])
    );
  }

  private responsesBridgeModels(isChatgptOAuth: boolean) {
    return this.catalogEntries.map(({ info }) => ({
      id: info.id,
      display_name: info.name,
      created_at: `${info.releaseDate || '2026-01-01'}T00:00:00Z`,
      context_window: isChatgptOAuth
        ? (codexBackendContextWindow(info.id) ?? info.contextWindow)
        : info.contextWindow,
      max_tokens: info.id.startsWith('gpt-5.6-') ? 128000 : 16384,
    }));
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

  private parseCodexRemoteModel(value: unknown): CodexRemoteModel | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (!this.isModelId(record.slug)) return undefined;
    if (typeof record.display_name !== 'string' || !record.display_name.trim()) return undefined;
    if (record.display_name.length > CODEX_MODEL_DISPLAY_NAME_MAX_LENGTH) return undefined;
    if (record.description !== undefined && typeof record.description !== 'string')
      return undefined;
    if (
      typeof record.description === 'string' &&
      record.description.length > CODEX_MODEL_DESCRIPTION_MAX_LENGTH
    )
      return undefined;
    if (!['list', 'hide', 'none'].includes(String(record.visibility))) return undefined;
    if (typeof record.supported_in_api !== 'boolean') return undefined;
    if (typeof record.priority !== 'number' || !Number.isSafeInteger(record.priority))
      return undefined;
    const contextWindow = this.optionalPositiveInteger(record.context_window);
    const maxContextWindow = this.optionalPositiveInteger(record.max_context_window);
    if (record.context_window !== undefined && contextWindow === undefined) return undefined;
    if (record.max_context_window !== undefined && maxContextWindow === undefined) return undefined;
    const supportedReasoningLevels = Array.isArray(record.supported_reasoning_levels)
      ? record.supported_reasoning_levels
      : [];
    return {
      slug: record.slug,
      displayName: record.display_name.trim(),
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxContextWindow ? { maxContextWindow } : {}),
      visibility: record.visibility as CodexModelVisibility,
      supportedInApi: record.supported_in_api,
      supportsReasoning:
        supportedReasoningLevels.length > 0 || resolveCodexBridgeModelId(record.slug) !== undefined,
      priority: record.priority,
    };
  }

  private isOpenAIResponsesModel(modelId: string): boolean {
    const baseModelId = modelId.startsWith('ft:') ? modelId.split(':')[1] : modelId;
    if (!baseModelId || !/^(?:gpt-|o\d|codex-)/.test(baseModelId)) return false;
    return !/(?:audio|embedding|image|instruct|moderation|realtime|search|transcri|tts|whisper)/i.test(
      baseModelId
    );
  }

  private parseOpenAIRemoteModel(value: unknown, priority: number): CodexRemoteModel | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (!this.isModelId(record.id)) return undefined;
    const supportedInApi = this.isOpenAIResponsesModel(record.id);
    return {
      slug: record.id,
      displayName: record.id,
      visibility: 'list',
      supportedInApi,
      supportsReasoning: resolveCodexBridgeModelId(record.id) !== undefined,
      priority,
    };
  }

  private parseRemoteModelList(
    values: unknown[],
    parse: (value: unknown, index: number) => CodexRemoteModel | undefined
  ): CodexRemoteModel[] | undefined {
    const models = values.flatMap((value, index) => {
      const model = parse(value, index);
      return model ? [model] : [];
    });
    return models.length > 0 ? models : undefined;
  }

  private parseRemoteModels(value: unknown): CodexRemoteModel[] | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.models)) {
      return this.parseRemoteModelList(record.models, (model) => this.parseCodexRemoteModel(model));
    }
    if (Array.isArray(record.data)) {
      return this.parseRemoteModelList(record.data, (model, priority) =>
        this.parseOpenAIRemoteModel(model, priority)
      );
    }
    return undefined;
  }

  private async writeModelCache(cache: CodexModelCache): Promise<void> {
    const dir = path.dirname(this.modelCachePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${this.modelCachePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(cache, null, 2), { mode: 0o600 });
      await fs.rename(tmpPath, this.modelCachePath);
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => undefined);
      throw error;
    }
  }

  private stopBridgeServerByKey(key: string): void {
    const server = this.bridgeServers.get(key);
    if (server) server.stop();
    this.bridgeServers.delete(key);
  }

  private resetBridgeServers(): void {
    for (const key of this.bridgeServers.keys()) this.stopBridgeServerByKey(key);
  }

  private updateBridgeAuth(auth: OpenAIResponsesBridgeAuth): void {
    this.bridgeServers.get(`responses:${this.bridgeAuthCacheKey(auth)}`)?.updateAuth(auth);
  }

  private replaceCatalog(
    entries: CodexCatalogEntry[],
    scope: CodexModelCacheScope | undefined
  ): void {
    this.catalogEntries = entries;
    this.activeCatalogScope = scope;
    for (const [key, server] of this.bridgeServers) {
      const authKey = key.slice('responses:'.length);
      const isChatgptOAuth = authKey.startsWith('chatgpt:');
      server.updateModels(this.responsesBridgeModels(isChatgptOAuth), this.modelAliases());
    }
  }

  private async requestModelCatalog(
    auth: OpenAIResponsesBridgeAuth,
    etag?: string
  ): Promise<Response> {
    const baseUrl =
      auth.source === 'chatgpt_oauth'
        ? 'https://chatgpt.com/backend-api/codex'
        : 'https://api.openai.com/v1';
    const url = new URL(`${baseUrl}/models`);
    url.searchParams.set('client_version', CODEX_COMPAT_CLIENT_VERSION);
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${auth.apiKey}`,
    };
    if (etag) headers['if-none-match'] = etag;
    if (auth.source === 'chatgpt_oauth') {
      if (auth.accountId) headers['ChatGPT-Account-ID'] = auth.accountId;
      if (auth.isFedrampAccount) headers['X-OpenAI-Fedramp'] = 'true';
    }
    return this.fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(CODEX_MODEL_FETCH_TIMEOUT_MS),
    });
  }

  private setDiscoveryError(message: string): void {
    this.discoveryError = new Error(message);
    logger.warn(message);
  }

  private async fetchModelCatalog(
    initialAuth: OpenAIResponsesBridgeAuth,
    revalidate: boolean
  ): Promise<void> {
    let auth = initialAuth;
    if (auth.source === 'chatgpt_oauth') {
      const credentials = await this.loadCredentials();
      if (credentials?.expires && Date.now() >= credentials.expires - 5 * 60 * 1000) {
        const refreshed = await this.refreshStoredOauthCredentials();
        const refreshedAuth = refreshed ? this.toBridgeAuth(refreshed) : undefined;
        if (refreshedAuth) {
          auth = refreshedAuth;
          this.updateBridgeAuth(auth);
        }
      }
    }
    let scope = this.authScope(auth);
    const matchingCache =
      revalidate && this.modelCache && this.cacheMatchesScope(this.modelCache, scope)
        ? this.modelCache
        : undefined;
    let response: Response;
    try {
      response = await this.requestModelCatalog(auth, matchingCache?.etag);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.setDiscoveryError(`AnthropicToCodexBridgeProvider: model discovery failed: ${detail}`);
      return;
    }

    if (response.status === 401 && auth.source === 'chatgpt_oauth') {
      await response.body?.cancel().catch(() => undefined);
      const refreshed = await this.refreshStoredOauthCredentials();
      const refreshedAuth = refreshed ? this.toBridgeAuth(refreshed) : undefined;
      if (refreshedAuth?.source === 'chatgpt_oauth') {
        auth = refreshedAuth;
        this.updateBridgeAuth(auth);
        scope = this.authScope(auth);
        try {
          response = await this.requestModelCatalog(auth);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.setDiscoveryError(
            `AnthropicToCodexBridgeProvider: model discovery retry failed: ${detail}`
          );
          return;
        }
      }
    }

    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Codex credentials rejected (HTTP 401)');
    }

    if (response.status === 304 && matchingCache) {
      if (!this.currentScopeMatches(scope)) return;
      this.discoveryError = undefined;
      const cache = { ...matchingCache, fetchedAt: new Date().toISOString() };
      this.modelCache = cache;
      this.activateCachedCatalog(scope);
      await this.writeModelCache(cache).catch((error) =>
        logger.warn('AnthropicToCodexBridgeProvider: model cache write failed:', error)
      );
      return;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const message = `AnthropicToCodexBridgeProvider: model discovery HTTP ${response.status}`;
      if (response.status >= 500) {
        this.setDiscoveryError(message);
      } else {
        logger.warn(message);
      }
      return;
    }

    let models: CodexRemoteModel[] | undefined;
    try {
      models = this.parseRemoteModels((await response.json()) as unknown);
    } catch {
      models = undefined;
    }
    const entries = models ? this.catalogEntriesFromRemote(models, scope.source) : [];
    if (!models || entries.length === 0 || !entries.some((entry) => entry.visibility === 'list')) {
      logger.warn('AnthropicToCodexBridgeProvider: model discovery returned no usable models');
      return;
    }
    if (!this.currentScopeMatches(scope)) return;

    this.discoveryError = undefined;
    this.replaceCatalog(entries, scope);
    const cache: CodexModelCache = {
      schemaVersion: CODEX_MODEL_CACHE_SCHEMA_VERSION,
      fetchedAt: new Date().toISOString(),
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag') ?? undefined } : {}),
      clientVersion: CODEX_COMPAT_CLIENT_VERSION,
      scope,
      models,
    };
    this.modelCache = cache;
    this.hydratedCacheEntries = entries;
    await this.writeModelCache(cache).catch((error) =>
      logger.warn('AnthropicToCodexBridgeProvider: model cache write failed:', error)
    );
  }

  clearModelCache(): void {
    this.forceModelRefresh = true;
  }

  async getModels(): Promise<ModelInfo[]> {
    const auth = await this.getBridgeAuth();
    if (!auth) return [];
    const scope = this.authScope(auth);
    this.ensureCatalogForScope(scope);
    if (
      this.forceModelRefresh ||
      !this.modelCache ||
      !this.isModelCacheFresh(this.modelCache, scope)
    ) {
      const refreshKey = this.scopeKey(scope);
      const activeRefresh = this.modelRefreshes.get(refreshKey);
      if (activeRefresh) await activeRefresh;
      if (
        this.forceModelRefresh ||
        !this.modelCache ||
        !this.isModelCacheFresh(this.modelCache, scope)
      ) {
        const revalidate = !this.forceModelRefresh;
        this.forceModelRefresh = false;
        const refresh = this.fetchModelCatalog(auth, revalidate).finally(() => {
          this.modelRefreshes.delete(refreshKey);
        });
        this.modelRefreshes.set(refreshKey, refresh);
        await refresh;
      }
    }
    return this.catalogEntries
      .filter((entry) => entry.visibility === 'list')
      .map((entry) => ({ ...entry.info }));
  }

  async healthCheck(): Promise<void> {
    this.discoveryError = undefined;
    this.clearModelCache();
    await this.getModels();
    if (this.discoveryError) throw this.discoveryError;
  }

  ownsModel(modelId: string): boolean {
    return this.catalogEntries.some(
      ({ info }) =>
        info.id === modelId || info.alias === modelId || info.providerAliases?.includes(modelId)
    );
  }

  translateModelIdForSdk(_modelId: string): string {
    return 'default';
  }

  getModelThinkingMode(modelId: string): 'off' | 'granular' | undefined {
    const entry = this.catalogEntries.find(
      ({ info }) =>
        info.id === modelId || info.alias === modelId || info.providerAliases?.includes(modelId)
    );
    return entry?.info.thinkingModes === 'off' ? 'off' : entry ? 'granular' : undefined;
  }

  getModelForTier(tier: ModelTier): string | undefined {
    const preferred: Record<ModelTier, string> = {
      opus: 'gpt-5.6-sol',
      sonnet: 'gpt-5.6-terra',
      haiku: 'gpt-5.6-luna',
      default: 'gpt-5.6-terra',
    };
    const preferredId = preferred[tier];
    if (
      this.catalogEntries.some(
        ({ info, visibility }) => info.id === preferredId && visibility === 'list'
      )
    )
      return preferredId;
    return this.catalogEntries.find(({ visibility }) => visibility === 'list')?.info.id;
  }

  buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    const sessionId = sessionConfig?.sessionId ?? 'default';
    const auth = this.resolveBridgeAuth();
    if (auth) this.ensureCatalogForScope(this.authScope(auth));
    const authKey = this.bridgeAuthCacheKey(auth);
    const bridgeKey = `responses:${authKey}`;
    let bridgeServer = this.bridgeServers.get(bridgeKey);
    for (const key of this.bridgeServers.keys()) {
      if (key !== bridgeKey) this.stopBridgeServerByKey(key);
    }
    let catalogEntry = this.catalogEntries.find(
      ({ info }) =>
        info.alias === modelId || info.id === modelId || info.providerAliases?.includes(modelId)
    );
    if (!catalogEntry) {
      const fallbackId = this.getModelForTier('default');
      catalogEntry = this.catalogEntries.find(({ info }) => info.id === fallbackId);
      if (!catalogEntry) throw new Error(`Unknown Codex model: ${modelId}`);
      logger.warn(`Unknown Codex model '${modelId}'; using '${catalogEntry.info.id}'`);
    }
    const entry = catalogEntry.info;
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
      logger.info(
        `AnthropicToCodexBridgeProvider: Responses bridge server started on port ${bridgeServer.port} for key=${bridgeKey}`
      );
    }

    const bridgeBaseUrl =
      bridgeServer.baseUrlForSession?.(sessionId) || `http://127.0.0.1:${bridgeServer.port}`;

    const sdkModelId =
      CODEX_TO_SDK_MODEL[resolvedId as import('./codex-models.js').CodexBridgeModelId] ??
      resolvedId;

    bridgeServer.setSessionModelConfig?.(sessionId, sdkModelId, resolvedId);
    this.sessionModelIds.set(sessionId, resolvedId);

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
        ANTHROPIC_DEFAULT_OPUS_MODEL:
          this.getModelForTier('opus') === 'gpt-5.6-sol'
            ? CODEX_TO_SDK_MODEL['gpt-5.6-sol']
            : sdkModelId,
        ANTHROPIC_DEFAULT_SONNET_MODEL: sdkModelId,
        ANTHROPIC_DEFAULT_HAIKU_MODEL:
          this.getModelForTier('haiku') === 'gpt-5.6-luna'
            ? CODEX_TO_SDK_MODEL['gpt-5.6-luna']
            : sdkModelId,
      },
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  setSessionThinkingConfig(sessionId: string, thinkingLevel: string | undefined): void {
    const auth = this.resolveBridgeAuth();
    const bridgeServer = this.bridgeServers.get(`responses:${this.bridgeAuthCacheKey(auth)}`);
    if (!bridgeServer?.setSessionThinkingConfig) return;

    const modelId = this.sessionModelIds.get(sessionId);
    if (modelId && this.getModelThinkingMode(modelId) === 'off') {
      bridgeServer.setSessionThinkingConfig(sessionId, undefined);
      return;
    }

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
    this.resetBridgeServers();
    this.sessionModelIds.clear();
    this.cachedCredentials = null;
    this.cachedBridgeAuth = undefined;
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
    } catch {
      // file does not exist — nothing to do
    }
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

import type { QueryLike } from '../agent/query-like.ts';
import type {
  Provider,
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderCredentials,
  ProviderOAuthFlowData,
  ProviderSdkConfig,
  ModelTier,
  ListRemoteModelsOptions,
} from '@hyperneo/shared/provider';
import type { ModelInfo } from '@hyperneo/shared';
import { resolveSDKCliPath, isRunningUnderBun } from '../agent/sdk-cli-resolver.js';
import { withSdkTranscriptRetention } from '../agent/sdk-transcript-retention.ts';
import { applyRecordedFailureToAuthStatus } from './provider-failure-store.js';
import { providerEnvCoordinator } from './provider-env-enrollment.ts';
import { canonicalAnthropicSdkAlias, isAnthropicSdkModelId } from './anthropic-sdk-models.js';
import {
  CLAUDE_SUBSCRIPTION_OAUTH_CONFIG,
  buildClaudeSubscriptionAuthorizeUrl,
  createClaudeSubscriptionPkce,
  createClaudeSubscriptionState,
  exchangeClaudeSubscriptionCode,
  parseClaudeSubscriptionCallback,
  refreshClaudeSubscriptionToken,
  type ClaudeSubscriptionTokenResponse,
} from './anthropic-subscription-oauth.js';
import { Logger } from '../logger.js';

const logger = new Logger('anthropic-provider');

const OAUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000;
const OAUTH_REFRESH_WINDOW_MS = 10 * 60 * 1000;

function isFullVersionId(modelId: string): boolean {
  return /^claude-(sonnet|opus|haiku|fable)-[\d-]+$/.test(modelId);
}

function readAccountEmail(credentials: ProviderCredentials | null): string | undefined {
  if (credentials?.type !== 'oauth') return undefined;
  const account = credentials.raw?.account as { email_address?: unknown } | undefined;
  return typeof account?.email_address === 'string' ? account.email_address : undefined;
}

function extractVersionFromDescription(description: string): string | null {
  const match = description.match(/(?:Opus|Sonnet|Haiku|Fable)\s+(\d+\.\d+)/i);
  return match ? match[1] : null;
}

function parseModelId(
  modelId: string,
  description?: string
): { family: string; version?: string } | null {
  const canonicalFamilies: Record<string, string> = {
    sonnet: 'sonnet',
    default: 'sonnet',
    opus: 'opus',
    haiku: 'haiku',
    fable: 'fable',
    'sonnet[1m]': 'sonnet',
  };

  if (modelId in canonicalFamilies) {
    const family = canonicalFamilies[modelId];
    const version = description ? extractVersionFromDescription(description) : null;
    const versionSuffix = modelId === 'sonnet[1m]' ? '-1m' : '';
    return {
      family,
      version: version ? `${version}${versionSuffix}` : undefined,
    };
  }

  const match = modelId.match(/^claude-(sonnet|opus|haiku|fable)-(\d+)-(\d+)(?:-\d{8})?$/);
  if (match) {
    const family = match[1];
    const major = match[2];
    const minor = match[3];
    return {
      family,
      version: `${major}.${minor}`,
    };
  }

  return null;
}

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic';

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    extendedThinking: true,
    thinkingModes: 'granular',
    maxContextWindow: 200000,
    functionCalling: true,
    vision: true,
  };

  private modelCache: ModelInfo[] | null = null;
  private credentials: ProviderCredentials | null = null;
  private credentialsVersion = 0;
  private credentialSignature: string | undefined;
  private readonly capturedAnthropicBaseUrl: string | undefined;
  private readonly credentialListeners = new Set<
    (credentials: ProviderCredentials) => void | Promise<void>
  >();
  private activeOAuthFlow: {
    state: string;
    verifier: string;
    authUrl: string;
    completed: boolean;
    finish: ((error?: Error) => void) | null;
  } | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly modelCacheKey: string = 'anthropic-global',
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.capturedAnthropicBaseUrl = env.ANTHROPIC_BASE_URL;
  }

  setCredentials(credentials: ProviderCredentials): void {
    const signature = JSON.stringify(credentials);
    if (signature !== this.credentialSignature) {
      this.credentialsVersion++;
      this.clearModelCache();
    }
    this.credentialSignature = signature;
    this.credentials = credentials;
  }

  getCredentials(): ProviderCredentials | null {
    return this.credentials;
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

  async startOAuthFlow(): Promise<ProviderOAuthFlowData> {
    if (this.activeOAuthFlow && !this.activeOAuthFlow.completed) {
      return {
        type: 'redirect',
        authUrl: this.activeOAuthFlow.authUrl,
        message: 'OAuth flow already in progress. Complete authentication in your browser.',
      };
    }

    const { verifier, challenge } = createClaudeSubscriptionPkce();
    const state = createClaudeSubscriptionState();
    const flow = {
      state,
      verifier,
      authUrl: buildClaudeSubscriptionAuthorizeUrl({
        state,
        codeChallenge: challenge,
        redirectUri: CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.manualRedirectUrl,
      }),
      completed: false,
      finish: null as ((error?: Error) => void) | null,
    };
    this.activeOAuthFlow = flow;
    this.awaitOAuthFlowCompletion(flow).catch((error) => {
      logger.error('Claude subscription OAuth flow failed:', error);
    });

    return {
      type: 'redirect',
      authUrl: flow.authUrl,
      message:
        'Authorize in your browser, then paste the code shown on the Anthropic page to finish.',
    };
  }

  private awaitOAuthFlowCompletion(
    flow: NonNullable<AnthropicProvider['activeOAuthFlow']>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        flow.finish?.(new Error('OAuth flow timed out'));
      }, OAUTH_FLOW_TIMEOUT_MS);
      flow.finish = (error?: Error) => {
        clearTimeout(timer);
        flow.completed = true;
        flow.finish = null;
        if (this.activeOAuthFlow === flow) {
          this.activeOAuthFlow = null;
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
    });
  }

  async submitOAuthCallback(
    callbackInput: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const flow = this.activeOAuthFlow;
    if (!flow || flow.completed) {
      return {
        ok: false,
        error: 'No active OAuth login flow. Start the login again and paste the code.',
      };
    }
    const parsed = parseClaudeSubscriptionCallback(callbackInput);
    if (!parsed) {
      return {
        ok: false,
        error: 'Paste the authorization code shown after authorizing (code#state).',
      };
    }
    if ('error' in parsed) {
      flow.finish?.(new Error(parsed.error));
      return { ok: false, error: `Authorization failed: ${parsed.error}` };
    }
    if (parsed.state !== flow.state) {
      return {
        ok: false,
        error:
          'The pasted code does not match the current login flow. Restart the login and paste the new code.',
      };
    }
    try {
      const tokens = await exchangeClaudeSubscriptionCode({
        code: parsed.code,
        state: flow.state,
        codeVerifier: flow.verifier,
        redirectUri: CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.manualRedirectUrl,
        fetchImpl: this.fetchImpl,
      });
      this.applyClaudeSubscriptionTokens(tokens);
      flow.finish?.();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Token exchange failed';
      flow.finish?.(error instanceof Error ? error : new Error(message));
      return { ok: false, error: message };
    }
  }

  private applyClaudeSubscriptionTokens(tokens: ClaudeSubscriptionTokenResponse): void {
    const credentials = this.toClaudeSubscriptionCredentials(tokens, this.credentials);
    this.setCredentials(credentials);
    this.notifyCredentialsChanged(credentials);
  }

  private toClaudeSubscriptionCredentials(
    tokens: ClaudeSubscriptionTokenResponse,
    previous: ProviderCredentials | null
  ): ProviderCredentials {
    const previousOauth = previous?.type === 'oauth' ? previous : null;
    const raw: Record<string, unknown> = { ...previousOauth?.raw };
    if (tokens.scope !== undefined) raw.scope = tokens.scope;
    if (tokens.account !== undefined) raw.account = tokens.account;
    if (tokens.organization !== undefined) raw.organization = tokens.organization;
    return {
      type: 'oauth',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? previousOauth?.refreshToken,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      raw,
    };
  }

  async refreshToken(): Promise<boolean> {
    const credentials = this.credentials;
    if (credentials?.type !== 'oauth' || !credentials.refreshToken) return false;
    const result = await refreshClaudeSubscriptionToken({
      refreshToken: credentials.refreshToken,
      fetchImpl: this.fetchImpl,
    });
    if (!result.ok) return false;
    this.applyClaudeSubscriptionTokens(result.token);
    return true;
  }

  async logout(): Promise<void> {
    this.activeOAuthFlow?.finish?.(new Error('OAuth flow cancelled'));
    this.activeOAuthFlow = null;
    if (this.credentials !== null) {
      this.credentials = null;
      this.credentialSignature = undefined;
      this.credentialsVersion++;
      this.clearModelCache();
    }
  }

  isAvailable(): boolean {
    return !!this.getApiKey();
  }

  getApiKey(): string | undefined {
    return (
      this.env.ANTHROPIC_API_KEY ||
      this.env.CLAUDE_CODE_OAUTH_TOKEN ||
      this.env.ANTHROPIC_AUTH_TOKEN ||
      (this.credentials?.type === 'api_key' ? this.credentials.apiKey : undefined) ||
      (this.credentials?.type === 'oauth' ? this.credentials.accessToken : undefined)
    );
  }

  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    return providerEnvCoordinator.runWithLease('anthropic.isAvailable', () => {
      const apiKey = this.getApiKey();
      const credentials = this.credentials;
      const expiresAt = credentials?.type === 'oauth' ? credentials.expiresAt : undefined;
      const needsRefresh =
        typeof expiresAt === 'number' && expiresAt - Date.now() <= OAUTH_REFRESH_WINDOW_MS;
      const account = readAccountEmail(credentials);
      return applyRecordedFailureToAuthStatus(this.id, {
        isAuthenticated: !!apiKey,
        method: credentials?.type ?? 'api_key',
        expiresAt,
        needsRefresh: needsRefresh || undefined,
        user: account ? { email: account } : undefined,
        error: apiKey
          ? undefined
          : 'Set ANTHROPIC_API_KEY, inherit Claude Code credentials, or log in with a Claude subscription.',
      });
    });
  }

  async shutdown(): Promise<void> {}

  async getModels(): Promise<ModelInfo[]> {
    if (this.modelCache) {
      return this.modelCache;
    }

    if (!this.isAvailable()) {
      return [];
    }

    return this.listRemoteModels();
  }

  async listRemoteModels(options?: ListRemoteModelsOptions): Promise<ModelInfo[]> {
    if (!this.isAvailable()) {
      throw new Error('Anthropic is not authenticated');
    }

    if (options?.force) {
      this.clearModelCache();
    } else if (this.modelCache) {
      return this.modelCache;
    }

    const credentialsVersion = this.credentialsVersion;
    const models = await this.loadModelsFromSdk();
    if (credentialsVersion !== this.credentialsVersion) {
      throw new Error('Anthropic credentials changed during model discovery');
    }
    this.modelCache = models;
    return models;
  }

  private async loadModelsFromSdk(timeout: number = 10000): Promise<ModelInfo[]> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const env = this.buildSdkConfig().envVars;
    const restoreEnv = this.applyEnvVarsForSdk(env);

    try {
      const tmpQuery = query({
        prompt: '',
        options: {
          model: 'default',
          cwd: process.cwd(),
          maxTurns: 0,
          pathToClaudeCodeExecutable: resolveSDKCliPath(),
          executable: isRunningUnderBun() ? 'bun' : undefined,
          settings: withSdkTranscriptRetention(),
        },
      });

      try {
        const sdkModels = await Promise.race([
          tmpQuery.supportedModels(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('SDK model load timeout')), timeout)
          ),
        ]);
        return this.convertSdkModels(sdkModels);
      } finally {
        tmpQuery.interrupt().catch(() => {});
      }
    } finally {
      restoreEnv();
    }
  }

  convertSdkModels(
    sdkModels: Array<{ value: string; displayName: string; description: string }>
  ): ModelInfo[] {
    sdkModels = sdkModels.filter((m) => isAnthropicSdkModelId(m.value));

    const canonicalIdsByFamily = new Map<string, string>();

    for (const sdkModel of sdkModels) {
      const alias = canonicalAnthropicSdkAlias(sdkModel.value);
      if (alias) {
        const parsed = parseModelId(alias, sdkModel.description);
        if (parsed && parsed.version) {
          const key = `${parsed.family}-${parsed.version}`;
          canonicalIdsByFamily.set(key, alias);
        }
      }
    }

    return sdkModels
      .filter((sdkModel) => {
        if (canonicalAnthropicSdkAlias(sdkModel.value)) {
          return true;
        }

        if (isFullVersionId(sdkModel.value)) {
          const parsed = parseModelId(sdkModel.value, sdkModel.description);
          if (parsed && parsed.version) {
            const key = `${parsed.family}-${parsed.version}`;
            const canonicalId = canonicalIdsByFamily.get(key);

            if (canonicalId) {
              return false;
            }
          }
        }

        return true;
      })
      .map((sdkModel) => {
        const alias = canonicalAnthropicSdkAlias(sdkModel.value);
        const modelId = alias === 'default' ? 'sonnet' : (alias ?? sdkModel.value);

        const description = sdkModel.description || '';
        const separatorIndex = description.indexOf(' · ');
        let displayName = description;
        if (separatorIndex > 0) {
          displayName = description.substring(0, separatorIndex);
        } else {
          displayName = sdkModel.displayName || sdkModel.value;
        }

        const currentlyMatch = displayName.match(/currently\s+([^)]+)/);
        if (currentlyMatch) {
          displayName = currentlyMatch[1].trim();
        }

        let family: 'opus' | 'sonnet' | 'haiku' | 'fable' = 'sonnet';
        const nameLower = displayName.toLowerCase();
        if (nameLower.includes('opus')) {
          family = 'opus';
        } else if (nameLower.includes('haiku')) {
          family = 'haiku';
        } else if (nameLower.includes('fable')) {
          family = 'fable';
        }

        return {
          id: modelId,
          name: displayName,
          alias: modelId,
          family,
          provider: 'anthropic',
          contextWindow: 200000,
          description: sdkModel.description || '',
          releaseDate: '',
          available: true,
        };
      });
  }

  ownsModel(modelId: string): boolean {
    const lower = modelId.toLowerCase();

    if (['sonnet', 'opus', 'haiku', 'fable'].includes(lower)) {
      return true;
    }

    if (lower === 'default') {
      return true;
    }

    if (lower.startsWith('claude-')) {
      return true;
    }

    const otherProviderPrefixes = [
      'glm-',
      'deepseek-',
      'openai-',
      'gpt-',
      'qwen-',
      'copilot-',
      'minimax-',
    ];
    if (otherProviderPrefixes.some((prefix) => lower.startsWith(prefix))) {
      return false;
    }

    return true;
  }

  getModelForTier(tier: ModelTier): string | undefined {
    const tierMap: Record<ModelTier, string> = {
      sonnet: 'sonnet',
      haiku: 'haiku',
      opus: 'opus',
      default: 'sonnet',
    };
    return tierMap[tier];
  }

  buildSdkConfig(): ProviderSdkConfig {
    const envVars: Record<string, string> = {};
    const hasEnvAuth =
      !!this.env.ANTHROPIC_API_KEY ||
      !!this.env.CLAUDE_CODE_OAUTH_TOKEN ||
      (!!this.env.ANTHROPIC_AUTH_TOKEN &&
        !this.env.ANTHROPIC_AUTH_TOKEN.startsWith('anthropic-copilot-proxy:'));
    if (!hasEnvAuth && this.credentials?.type === 'api_key') {
      envVars.ANTHROPIC_API_KEY = this.credentials.apiKey;
    } else if (!hasEnvAuth && this.credentials?.type === 'oauth' && this.credentials.accessToken) {
      envVars.CLAUDE_CODE_OAUTH_TOKEN = this.credentials.accessToken;
    }

    return {
      envVars,
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  private applyEnvVarsForSdk(envVars: Record<string, string>): () => void {
    const originals = new Map<string, string | undefined>();

    if (process.env.ANTHROPIC_BASE_URL !== undefined) {
      if (process.env.ANTHROPIC_BASE_URL !== this.capturedAnthropicBaseUrl) {
        originals.set('ANTHROPIC_BASE_URL', process.env.ANTHROPIC_BASE_URL);
        delete process.env.ANTHROPIC_BASE_URL;
      }
    }
    if (process.env.ANTHROPIC_AUTH_TOKEN?.startsWith('anthropic-copilot-proxy:')) {
      originals.set('ANTHROPIC_AUTH_TOKEN', process.env.ANTHROPIC_AUTH_TOKEN);
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }

    for (const [key, value] of Object.entries(envVars)) {
      originals.set(key, process.env[key]);
      process.env[key] = value;
    }

    return () => {
      for (const [key, value] of originals) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };
  }

  setModelCache(models: ModelInfo[]): void {
    this.modelCache = models;
  }

  clearModelCache(): void {
    this.modelCache = null;
  }
}

export async function getAnthropicModelsFromQuery(
  queryObject: QueryLike | null
): Promise<ModelInfo[]> {
  if (!queryObject || typeof queryObject.supportedModels !== 'function') {
    return [];
  }

  const provider = new AnthropicProvider();
  try {
    const sdkModels = await queryObject.supportedModels();
    return provider.convertSdkModels(sdkModels);
  } catch {
    return [];
  }
}

import { getDataDir } from '../../data-dir';
import type {
  Provider,
  ProviderCapabilities,
  ProviderSdkConfig,
  ProviderSessionConfig,
  ModelTier,
  ProviderAuthStatusInfo,
  ProviderCredentials,
  ProviderOAuthFlowData,
} from '@hyperneo/shared/provider';
import type { ModelInfo } from '@hyperneo/shared';
import { CopilotClient, type ModelInfo as CopilotSdkModelInfo } from '@github/copilot-sdk';
import { startEmbeddedServer, type EmbeddedServer } from './server.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Logger } from '../../logger.js';
import { buildCopilotEnv } from './bun-node-wrapper.js';
import { COPILOT_ANTHROPIC_MODELS } from './models.js';

const execFileAsync = promisify(execFile);
const logger = new Logger('anthropic-copilot-provider');

function pickModelForTier(models: ModelInfo[], tier: ModelTier): string | undefined {
  if (models.length === 0) return undefined;
  const available = models.filter((m) => m.available !== false);
  if (available.length === 0) return undefined;

  const keywordsByTier: Record<ModelTier, string[]> = {
    opus: ['opus', 'pro', 'ultra'],
    sonnet: ['sonnet', '4o', 'turbo'],
    haiku: ['mini', 'haiku', 'flash', 'fast', 'lite'],
    default: ['sonnet', '4o', 'turbo'],
  };
  const keywords = keywordsByTier[tier] ?? [];
  for (const kw of keywords) {
    const match = available.find((m) => m.id.toLowerCase().includes(kw));
    if (match) return match.id;
  }
  return available[0].id;
}

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

interface StoredCopilotCredentials {
  refresh: string;
  enterpriseUrl?: string;
}

interface DeviceFlowResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

type TokenSource = 'auth-file' | 'copilot-env' | 'gh-env' | 'gh-cli' | 'hosts';

const EXTERNAL_SOURCE_LABELS: Partial<Record<TokenSource, string>> = {
  'copilot-env': 'the COPILOT_GITHUB_TOKEN environment variable',
  'gh-env': 'the GH_TOKEN environment variable',
  'gh-cli': 'the gh CLI (gh auth logout)',
  hosts: 'the gh CLI hosts.yml oauth_token',
};

interface TokenCacheEntry {
  token: string | undefined;
  expiresAt: number;
  source?: TokenSource;
}

const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

export class AnthropicToCopilotBridgeProvider implements Provider {
  readonly id = 'anthropic-copilot';
  readonly displayName = 'GitHub Copilot (Anthropic API)';

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    extendedThinking: false,
    thinkingModes: 'off',
    maxContextWindow: 272000,
    functionCalling: true,
    vision: false,
  };

  private clientCache: CopilotClient | undefined = undefined;
  private serverCache: EmbeddedServer | undefined = undefined;
  private serverStarting: Promise<EmbeddedServer> | undefined = undefined;
  private runtimeGeneration = 0;
  private tokenCache: TokenCacheEntry | null = null;
  private storedCredentialToken: string | null = null;
  private readonly credentialListeners = new Set<
    (credentials: ProviderCredentials) => void | Promise<void>
  >();
  private dynamicModelsCache: ModelInfo[] | null = null;
  private dynamicModelsCacheExpiresAt = 0;

  private readonly authPath: string;

  private activeOAuthFlow: {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresAt: number;
    completed: boolean;
    success: boolean;
  } | null = null;

  constructor(
    private readonly cwd: string = process.cwd(),
    private readonly env: NodeJS.ProcessEnv = process.env,
    authDir?: string
  ) {
    this.authPath = path.join(authDir || getDataDir(), 'auth.json');
  }

  setCredentials(credentials: ProviderCredentials): void {
    const token =
      credentials.type === 'api_key'
        ? credentials.apiKey
        : (credentials.accessToken ?? credentials.refreshToken);
    if (!token) return;
    const previousToken = this.storedCredentialToken ?? this.tokenCache?.token;
    if (previousToken !== token) {
      this.resetCredentialBoundCaches();
    }
    this.storedCredentialToken = token;
    this.tokenCache = { token, expiresAt: Number.POSITIVE_INFINITY };
  }

  clearModelCache(): void {
    this.dynamicModelsCache = null;
    this.dynamicModelsCacheExpiresAt = 0;
  }

  private resetCredentialBoundCaches(): void {
    this.clearModelCache();
    void this.resetEmbeddedRuntime();
  }

  private async resetEmbeddedRuntime(): Promise<void> {
    const starting = this.serverStarting;
    const server = this.serverCache;
    const client = this.clientCache;
    this.runtimeGeneration += 1;
    this.serverStarting = undefined;
    this.serverCache = undefined;
    this.clientCache = undefined;
    if (server) {
      await server.stop().catch((err: unknown) => {
        logger.warn('Error stopping embedded Anthropic server:', err);
      });
    }
    if (client) {
      await client.stop().catch((err: unknown) => {
        logger.warn('Error stopping CopilotClient:', err);
      });
    }
    if (starting) {
      const started = await starting.catch(() => undefined);
      if (started) {
        await started.stop().catch(() => {});
      }
    }
  }

  async getCredentials(): Promise<ProviderCredentials | null> {
    const token = this.storedCredentialToken ?? this.tokenCache?.token;
    if (token) return { type: 'oauth', accessToken: token };

    try {
      const fileToken = await this.loadStoredGitHubToken();
      if (fileToken) return { type: 'oauth', accessToken: fileToken };
    } catch {}

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
    const token = await this.resolveGitHubToken();
    if (!token || token.startsWith('ghp_')) return false;
    return true;
  }

  async getModels(): Promise<ModelInfo[]> {
    if (!(await this.isAvailable())) return [];
    try {
      await this.ensureServerStarted();
    } catch (err) {
      logger.error('Failed to start embedded Anthropic server:', err);
      return [];
    }

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

    const cache = this.dynamicModelsCache;
    if (cache && cache.length > 0) {
      if (cache.some((m) => m.id === staticId || m.alias === staticId)) {
        return staticId;
      }
      const preferred = pickModelForTier(cache, tier);
      if (preferred) return preferred;
    }

    return staticId;
  }

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
    const workspacePath = (sessionConfig?.workspacePath as string | undefined) ?? this.cwd;

    return {
      envVars: {
        ANTHROPIC_BASE_URL: this.serverCache.url,
        ANTHROPIC_AUTH_TOKEN: `anthropic-copilot-proxy:${workspacePath}`,
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        API_TIMEOUT_MS: '300000',
        ANTHROPIC_DEFAULT_OPUS_MODEL: resolvedId,
        ANTHROPIC_DEFAULT_SONNET_MODEL: resolvedId,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: resolvedId,
      },
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    try {
      const token = await this.resolveGitHubToken(true);
      if (!token) {
        return {
          isAuthenticated: false,
          error: 'Not logged in. Click Login to authenticate with GitHub Copilot.',
        };
      }
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
        errorKind: 'transient',
      };
    }
  }

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

  async logout(): Promise<void> {
    const cachedExternalSource = this.freshCachedExternalSource();
    this.storedCredentialToken = null;
    this.tokenCache = null;
    this.resetCredentialBoundCaches();

    try {
      const content = await fs.readFile(this.authPath, 'utf-8');
      const data = JSON.parse(content) as Record<string, unknown>;
      delete data['github-copilot'];

      if (Object.keys(data).length === 0) {
        await fs.unlink(this.authPath);
      } else {
        await fs.writeFile(this.authPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      }
    } catch {}

    const externalSource = (await this.findExternalCredentialSource()) ?? cachedExternalSource;
    if (externalSource) {
      throw new Error(
        `GitHub Copilot credentials are managed by ${externalSource}. ` +
          'Remove that source to log out.'
      );
    }
  }

  private freshCachedExternalSource(): string | undefined {
    if (!this.tokenCache || Date.now() >= this.tokenCache.expiresAt) return undefined;
    const { token, source } = this.tokenCache;
    if (!token || token.startsWith('ghp_') || !source) return undefined;
    return EXTERNAL_SOURCE_LABELS[source];
  }

  private async findExternalCredentialSource(): Promise<string | undefined> {
    const envToken = this.env.COPILOT_GITHUB_TOKEN || this.env.GH_TOKEN;
    if (envToken) {
      if (envToken.startsWith('ghp_')) return undefined;
      return this.env.COPILOT_GITHUB_TOKEN
        ? EXTERNAL_SOURCE_LABELS['copilot-env']
        : EXTERNAL_SOURCE_LABELS['gh-env'];
    }
    const ghCliToken = await this.tryGhCliToken();
    if (ghCliToken) {
      return ghCliToken.startsWith('ghp_') ? undefined : EXTERNAL_SOURCE_LABELS['gh-cli'];
    }
    const hostsToken = await this.tryGhHostsToken();
    if (hostsToken) {
      return hostsToken.startsWith('ghp_') ? undefined : EXTERNAL_SOURCE_LABELS['hosts'];
    }
    return undefined;
  }

  async shutdown(): Promise<void> {
    await this.resetEmbeddedRuntime();
  }

  async ensureServerStarted(): Promise<string> {
    if (this.serverCache) return this.serverCache.url;

    if (!this.serverStarting) {
      this.serverStarting = this.createServer();
    }
    const starting = this.serverStarting;

    let server: EmbeddedServer;
    try {
      server = await starting;
    } catch (err) {
      if (this.serverStarting === starting) {
        this.serverStarting = undefined;
      }
      throw err;
    }

    if (this.serverStarting !== starting) {
      return this.ensureServerStarted();
    }

    this.serverCache = server;
    this.serverStarting = undefined;
    return server.url;
  }

  private async resolveGitHubToken(
    propagateStoredCredentialError = false
  ): Promise<string | undefined> {
    if (this.storedCredentialToken) {
      return this.storedCredentialToken;
    }

    if (
      this.tokenCache &&
      Date.now() < this.tokenCache.expiresAt &&
      (!propagateStoredCredentialError || this.tokenCache.token)
    ) {
      return this.tokenCache.token;
    }

    const { token, source } = await this.discoverGitHubToken(propagateStoredCredentialError);
    this.tokenCache = { token, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS, source };
    return token;
  }

  private async discoverGitHubToken(
    propagateStoredCredentialError = false
  ): Promise<{ token: string | undefined; source: TokenSource }> {
    let stored: string | undefined;
    let storedCredentialError: unknown;
    let storedCredentialLookupFailed = false;
    try {
      stored = await this.loadStoredGitHubToken();
    } catch (error) {
      storedCredentialError = error;
      storedCredentialLookupFailed = true;
    }
    if (stored) return { token: stored, source: 'auth-file' };

    if (this.env.COPILOT_GITHUB_TOKEN) {
      return { token: this.env.COPILOT_GITHUB_TOKEN, source: 'copilot-env' };
    }

    if (this.env.GH_TOKEN) return { token: this.env.GH_TOKEN, source: 'gh-env' };

    const ghCliToken = await this.tryGhCliToken();
    if (ghCliToken) return { token: ghCliToken, source: 'gh-cli' };

    const hostsToken = await this.tryGhHostsToken();
    if (hostsToken) return { token: hostsToken, source: 'hosts' };

    if (propagateStoredCredentialError && storedCredentialLookupFailed) {
      throw storedCredentialError;
    }

    return { token: undefined, source: 'hosts' };
  }

  private async loadStoredGitHubToken(): Promise<string | undefined> {
    let content: string;
    try {
      content = await fs.readFile(this.authPath, 'utf-8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }

    const data = JSON.parse(content) as Record<string, unknown>;
    const creds = data['github-copilot'] as StoredCopilotCredentials | undefined;
    if (creds?.refresh && typeof creds.refresh === 'string') {
      return creds.refresh;
    }
    return undefined;
  }

  private async tryGhCliToken(): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 5000 });
      const token = stdout.trim();
      return token || undefined;
    } catch {
      return undefined;
    }
  }

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
        'User-Agent': 'GitHubCopilotChat/0.38.0',
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
    let pollIntervalSec = device.interval;

    while (Date.now() - startTime < expiresMs) {
      if (!this.activeOAuthFlow || this.activeOAuthFlow.completed) return;

      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollIntervalSec * 1000);
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

        const credentials: StoredCopilotCredentials = {
          refresh: data.access_token,
          enterpriseUrl: enterpriseDomain,
        };

        await this.saveCredentials(credentials);
        this.storedCredentialToken = null;
        this.tokenCache = null;
        this.resetCredentialBoundCaches();
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
    } catch {}

    data['github-copilot'] = credentials;

    await fs.writeFile(this.authPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  private mapCopilotSdkModel(m: CopilotSdkModelInfo): ModelInfo {
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
      const generation = this.runtimeGeneration;
      const env: NodeJS.ProcessEnv = { ...this.env };
      if (token) {
        env.COPILOT_GITHUB_TOKEN = token;
      }
      const client = new CopilotClient({
        useStdio: true,
        logLevel: 'error',
        env: buildCopilotEnv(env),
      });
      await client.start();
      if (generation !== this.runtimeGeneration) {
        await client.stop().catch(() => {});
        throw new Error('Copilot runtime was reset during client start');
      }
      this.clientCache = client;
      logger.debug('Created CopilotClient (bundled CLI path)');
    }
    return this.clientCache;
  }
}

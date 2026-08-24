import type { QueryLike } from '../agent/query-like';
import type {
  Provider,
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderCredentials,
  ProviderSdkConfig,
  ModelTier,
  ListRemoteModelsOptions,
} from '@hyperneo/shared/provider';
import type { ModelInfo } from '@hyperneo/shared';
import { resolveSDKCliPath, isRunningUnderBun } from '../agent/sdk-cli-resolver.js';
import { withSdkTranscriptRetention } from '../agent/sdk-transcript-retention';
import { applyRecordedFailureToAuthStatus } from './provider-failure-store.js';

const CANONICAL_SDK_IDS = new Set(['default', 'sonnet', 'opus', 'haiku', 'fable', 'sonnet[1m]']);

function isAnthropicSdkModelId(modelId: string): boolean {
  if (CANONICAL_SDK_IDS.has(modelId)) return true;
  return modelId.toLowerCase().startsWith('claude-');
}

function isFullVersionId(modelId: string): boolean {
  return /^claude-(sonnet|opus|haiku|fable)-[\d-]+$/.test(modelId);
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

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly modelCacheKey: string = 'anthropic-global'
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
    const apiKey = this.getApiKey();
    return applyRecordedFailureToAuthStatus(this.id, {
      isAuthenticated: !!apiKey,
      method: this.credentials?.type ?? 'api_key',
      error: apiKey ? undefined : 'Set ANTHROPIC_API_KEY or log in with Claude Code OAuth.',
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
      if (CANONICAL_SDK_IDS.has(sdkModel.value)) {
        const parsed = parseModelId(sdkModel.value, sdkModel.description);
        if (parsed && parsed.version) {
          const key = `${parsed.family}-${parsed.version}`;
          canonicalIdsByFamily.set(key, sdkModel.value);
        }
      }
    }

    return sdkModels
      .filter((sdkModel) => {
        if (CANONICAL_SDK_IDS.has(sdkModel.value)) {
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
        const modelId = sdkModel.value === 'default' ? 'sonnet' : sdkModel.value;

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

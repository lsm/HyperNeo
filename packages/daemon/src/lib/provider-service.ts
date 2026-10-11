import type { Provider, ProviderInfo, Session } from '@hyperneo/shared';
import type {
  Provider as SdkProvider,
  ProviderInfo as NewProviderInfo,
  ProviderSdkConfig,
  ProviderSessionConfig,
} from '@hyperneo/shared/provider';
import { Logger } from './logger.js';
import { initializeProviders, waitForOptionalProviderRegistration } from './providers/factory.js';
import {
  makeSessionProviderEnvStages,
  runSessionProviderEnvPipeline,
} from './providers/session-provider-env-pipeline.js';
import { providerSessionConfigForSession } from './providers/session-config.js';
import { selectTitleGenerationModel } from './title-model-selection.js';

function toLegacyProviderInfo(newInfo: NewProviderInfo): ProviderInfo {
  return {
    id: newInfo.id as Provider,
    name: newInfo.name,
    baseUrl: undefined,
    models: newInfo.models,
    available: newInfo.available,
  };
}

export const NON_ANTHROPIC_PREFIX_PROVIDER_VARS = [
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'ENABLE_TOOL_SEARCH',
] as const;

export interface ProviderEnvVars {
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_MODEL?: string;
  CLAUDE_CODE_SUBAGENT_MODEL?: string;
  ENABLE_TOOL_SEARCH?: string;
  ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
  ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
  ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
  API_TIMEOUT_MS?: string;
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC?: string;
  CLAUDE_CODE_AUTO_COMPACT_WINDOW?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  ANTHROPIC_CUSTOM_HEADERS?: string;
  [key: string]: string | undefined;
}

export interface OriginalEnvVars {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_MODEL?: string;
  CLAUDE_CODE_SUBAGENT_MODEL?: string;
  ENABLE_TOOL_SEARCH?: string;
  API_TIMEOUT_MS?: string;
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC?: string;
  CLAUDE_CODE_AUTO_COMPACT_WINDOW?: string;
  ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
  ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
  ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  ANTHROPIC_CUSTOM_HEADERS?: string;
  CLAUDE_AGENT_SDK_CLIENT_APP?: string;
  PORT?: string;
  HYPERNEO_PORT?: string;
  NEOKAI_PORT?: string;
}

function mergeOriginalEnvVars(...originals: OriginalEnvVars[]): OriginalEnvVars {
  const merged: OriginalEnvVars = {};
  for (const original of originals) {
    for (const [key, value] of Object.entries(original)) {
      if (!Object.hasOwn(merged, key)) {
        Reflect.set(merged, key, value);
      }
    }
  }
  return merged;
}

function sdkConfigToEnvVars(sdkConfig: ProviderSdkConfig): ProviderEnvVars {
  const envVars: ProviderEnvVars = { ...sdkConfig.envVars };

  if (sdkConfig.sdkOptions) {
    for (const [key, value] of Object.entries(sdkConfig.sdkOptions)) {
      if (key.startsWith('ANTHROPIC_') && typeof value === 'string') {
        envVars[key as keyof ProviderEnvVars] = value;
      }
    }
  }

  return envVars;
}

export class ProviderService {
  private readonly logger = new Logger('provider-service');

  private async ensureProviderBridges(
    provider:
      | {
          ensureBridgeStarted?(
            modelId: string,
            sessionConfig?: ProviderSessionConfig
          ): Promise<void>;
        }
      | undefined,
    modelId: string,
    sessionConfig?: ProviderSessionConfig
  ): Promise<void> {
    try {
      await provider?.ensureBridgeStarted?.(modelId, sessionConfig);
    } catch {}
  }

  private getRegistry() {
    return initializeProviders();
  }

  private async getReadyRegistry() {
    const registry = this.getRegistry();
    await waitForOptionalProviderRegistration(registry);
    return registry;
  }

  async getDefaultProvider(): Promise<Provider> {
    const registry = await this.getReadyRegistry();
    const provider = await registry.getDefaultProvider();
    return provider.id as Provider;
  }

  getProviderApiKey(providerId: Provider): string | undefined {
    const registry = this.getRegistry();
    const provider = registry.get(providerId);

    if (!provider) {
      return undefined;
    }

    if (providerId === 'anthropic') {
      return (
        process.env.ANTHROPIC_API_KEY ||
        process.env.CLAUDE_CODE_OAUTH_TOKEN ||
        process.env.ANTHROPIC_AUTH_TOKEN
      );
    }
    if (providerId === 'glm') {
      return process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY;
    }
    if (providerId === 'minimax') {
      return process.env.MINIMAX_API_KEY;
    }
    if (providerId === 'opencode') {
      return process.env.OPENCODE_API_KEY || process.env.OPENCODE_GO_API_KEY;
    }
    if (providerId === 'deepseek') {
      return process.env.DEEPSEEK_API_KEY;
    }
    if (providerId === 'kimi') {
      return process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY;
    }
    if (providerId === 'openrouter') {
      return process.env.OPENROUTER_API_KEY;
    }
    if (providerId === 'ollama') {
      return process.env.OLLAMA_API_KEY;
    }
    if (providerId === 'ollama-cloud') {
      return process.env.OLLAMA_CLOUD_API_KEY;
    }

    return undefined;
  }

  async isProviderAvailable(providerId: string): Promise<boolean> {
    const registry = await this.getReadyRegistry();
    const provider = registry.get(providerId);

    if (!provider) {
      return false;
    }

    return await provider.isAvailable();
  }

  async getProviderInfo(providerId: Provider): Promise<ProviderInfo> {
    const registry = await this.getReadyRegistry();
    const provider = registry.get(providerId);

    if (!provider) {
      return {
        id: providerId,
        name: providerId,
        baseUrl: undefined,
        models: [],
        available: false,
      };
    }

    const available = await provider.isAvailable();
    const models = await provider.getModels();

    let baseUrl: string | undefined;
    await this.ensureProviderBridges(provider, models[0]?.id || 'default');
    try {
      const sdkConfig = provider.buildSdkConfig(models[0]?.id || 'default');
      baseUrl = Object.keys(sdkConfig.envVars).includes('ANTHROPIC_BASE_URL')
        ? (sdkConfig.envVars.ANTHROPIC_BASE_URL as string | undefined)
        : undefined;
    } catch {
      baseUrl = undefined;
    }

    return {
      id: provider.id as Provider,
      name: provider.displayName,
      baseUrl,
      models: models.map((m) => m.id),
      available,
    };
  }

  async getAvailableProviders(): Promise<ProviderInfo[]> {
    const registry = await this.getReadyRegistry();
    const newProviderInfos = await registry.getProviderInfo();
    return newProviderInfos.map(toLegacyProviderInfo);
  }

  async validateProviderSwitch(
    providerId: Provider,
    apiKey?: string
  ): Promise<{ valid: boolean; error?: string }> {
    const registry = await this.getReadyRegistry();
    return await registry.validateProviderSwitch(providerId, apiKey);
  }

  async getDefaultModelForProvider(providerId: Provider): Promise<string> {
    const registry = await this.getReadyRegistry();
    const provider = registry.get(providerId);

    if (!provider) {
      return 'default';
    }

    const models = await provider.getModels();
    return models[0]?.id || 'default';
  }

  async getTitleGenerationModels(
    providerId: string,
    sessionModelId: string
  ): Promise<{ providerModelId: string; sdkModelId: string } | null> {
    const registry = await this.getReadyRegistry();
    const provider = registry.get(providerId);
    const titleOverride = provider?.getTitleGenerationModel?.();
    const result = await selectTitleGenerationModel({
      providerId,
      provider,
      candidates: [titleOverride, sessionModelId],
      ensureBuildable: true,
      registry: this.getRegistry(),
      ensureBridges: (p, modelId) => this.ensureProviderBridges(p, modelId),
    });
    if (result.status === 'unavailable') return null;
    const providerModelId = result.providerModelId ?? titleOverride ?? sessionModelId;
    const sdkModelId =
      result.sdkConfig?.envVars.ANTHROPIC_MODEL ??
      provider?.translateModelIdForSdk?.(providerModelId) ??
      providerModelId;
    return {
      providerModelId,
      sdkModelId,
    };
  }

  async getCheapTierModel(providerId: string): Promise<string | null> {
    const registry = await this.getReadyRegistry();
    const provider = registry.get(providerId);
    if (!provider) return null;
    const result = await selectTitleGenerationModel({
      providerId,
      provider,
      candidates: [provider.getTitleGenerationModel?.(), provider.getModelForTier?.('haiku')],
      ensureBuildable: false,
      registry: this.getRegistry(),
      ensureBridges: () => Promise.resolve(),
    });
    if (result.status !== 'selected' || !result.providerModelId) return null;
    return result.providerModelId;
  }

  async getTitleGenerationModel(
    providerId: string,
    sessionModelId: string
  ): Promise<string | null> {
    const models = await this.getTitleGenerationModels(providerId, sessionModelId);
    return models?.sdkModelId ?? null;
  }

  async getTitleGenerationConfig(providerId: string): Promise<{
    modelId: string;
    baseUrl: string;
    apiVersion: string;
  } | null> {
    const registry = await this.getReadyRegistry();
    const provider = registry.get(providerId);

    if (!provider) {
      return {
        modelId: 'haiku',
        baseUrl: 'https://api.anthropic.com',
        apiVersion: 'v1',
      };
    }

    const titleOverride = provider.getTitleGenerationModel?.();
    const tierFallback = provider.getModelForTier('haiku');
    const result = await selectTitleGenerationModel({
      providerId,
      provider,
      candidates: [titleOverride, tierFallback],
      ensureBuildable: true,
      registry: this.getRegistry(),
      ensureBridges: (p, modelId) => this.ensureProviderBridges(p, modelId),
    });
    let modelId = result.providerModelId;
    if (!modelId) {
      if (registry.getCuratedModels(providerId) !== undefined) return null;
      modelId = 'default';
    }

    let baseUrl = 'https://api.anthropic.com';
    let apiVersion = 'v1';
    if (result.sdkConfig) {
      modelId = result.sdkConfig.envVars.ANTHROPIC_MODEL ?? modelId;
      baseUrl = (result.sdkConfig.envVars.ANTHROPIC_BASE_URL as string | undefined) || baseUrl;
      apiVersion = result.sdkConfig.apiVersion || apiVersion;
    } else {
      this.logger.warn(
        `[ProviderService] getTitleGenerationConfig: buildSdkConfig failed for provider` +
          ` '${providerId}' — falling back to Anthropic defaults. Cause: ${result.buildError}`
      );
    }

    return { modelId, baseUrl, apiVersion };
  }

  async isModelValidForProvider(providerId: Provider, model: string): Promise<boolean> {
    const registry = await this.getReadyRegistry();
    const provider = registry.get(providerId);

    if (!provider) {
      return false;
    }

    return provider.ownsModel(model);
  }

  async getEnvVarsForModel(modelId: string, providerId: string): Promise<ProviderEnvVars> {
    await this.getReadyRegistry();
    const registry = this.getRegistry();
    const provider = registry.detectProviderForModel(modelId, providerId);

    if (!provider) {
      return {};
    }

    await this.ensureProviderBridges(provider, modelId);
    try {
      const sdkConfig = provider.buildSdkConfig(modelId);
      if (provider.id === 'anthropic' && process.env.HYPERNEO_USE_DEV_PROXY === '1') {
        sdkConfig.envVars = {
          ...sdkConfig.envVars,
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:8000',
        };
      }
      return sdkConfigToEnvVars(sdkConfig);
    } catch {
      return {};
    }
  }

  getProviderEnvVars(session: Session): ProviderEnvVars {
    const registry = this.getRegistry();
    const providerId = session.config.provider || 'anthropic';
    const provider = registry.get(providerId);

    if (!provider) {
      return {};
    }

    const sessionConfig = providerSessionConfigForSession(session);

    const modelId = session.config.model || 'default';
    try {
      return this.buildSessionEnvVars(provider, modelId, sessionConfig);
    } catch {
      return {};
    }
  }

  async resolveSessionProviderEnvVars(session: Session): Promise<ProviderEnvVars> {
    const registry = await this.getReadyRegistry();
    const providerId = session.config.provider || 'anthropic';

    return runSessionProviderEnvPipeline(
      makeSessionProviderEnvStages({
        getProvider: (id) => registry.get(id),
        ensureBridgeBestEffort: async (provider, modelId, sessionConfig) => {
          await this.ensureProviderBridges(provider, modelId, sessionConfig);
        },
        retryBridgeStart: async (provider, modelId, sessionConfig) => {
          await provider.ensureBridgeStarted?.(modelId, sessionConfig);
        },
        buildEnvVars: (provider, modelId, sessionConfig) =>
          this.buildSessionEnvVars(provider, modelId, sessionConfig),
      }),
      {
        providerId,
        modelId: session.config.model || 'default',
        sessionConfig: providerSessionConfigForSession(session),
        sessionId: session.id,
        provider: registry.get(providerId) ?? null,
      }
    );
  }

  private buildSessionEnvVars(
    provider: Pick<SdkProvider, 'id' | 'buildSdkConfig'>,
    modelId: string,
    sessionConfig: ProviderSessionConfig
  ): ProviderEnvVars {
    const sdkConfig = provider.buildSdkConfig(modelId, sessionConfig);
    if (provider.id === 'anthropic' && process.env.HYPERNEO_USE_DEV_PROXY === '1') {
      sdkConfig.envVars = {
        ...sdkConfig.envVars,
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8000',
      };
    }
    return sdkConfigToEnvVars(sdkConfig);
  }

  applyEnvVarsToProcessForSession(session: Session): OriginalEnvVars {
    const envVars = this.getProviderEnvVars(session);
    return this.applyResolvedProviderEnvVarsToProcess(session, envVars);
  }

  applyResolvedProviderEnvVarsToProcess(
    session: Session,
    envVars: ProviderEnvVars
  ): OriginalEnvVars {
    const cleared = this.clearProviderRoutingEnvVars({
      preserveUserSettings: session.config.provider === 'anthropic',
    });

    if (Object.keys(envVars).length === 0) {
      return cleared;
    }

    return mergeOriginalEnvVars(
      cleared,
      this.applyEnvVars(envVars, { preserveApiKey: session.config.provider === 'anthropic' })
    );
  }

  async getIsolatedEnvForModel(providerId: string, modelId: string): Promise<NodeJS.ProcessEnv> {
    const preserve = providerId === 'anthropic';
    const providerEnvVars = await this.getEnvVarsForModel(modelId, providerId);
    const env: NodeJS.ProcessEnv = { ...process.env };
    this.clearProviderRoutingEnvVars({ preserveUserSettings: preserve }, env);
    this.applyEnvVars(providerEnvVars, { preserveApiKey: preserve }, env);
    return { ...env, ...providerEnvVars };
  }

  private applyEnvVars(
    envVars: ProviderEnvVars,
    options: { preserveApiKey?: boolean } = {},
    env: NodeJS.ProcessEnv = process.env
  ): OriginalEnvVars {
    const original: OriginalEnvVars = {};

    const set = (key: ProviderEnvKey, emptyDeletes: boolean): void => {
      const value = envVars[key];
      if (value === undefined) return;
      original[key] = env[key];
      if (emptyDeletes && value === '') delete env[key];
      else env[key] = value;
    };
    for (const [key, emptyDeletes] of PROVIDER_AUTH_ENV) set(key, emptyDeletes);
    if (envVars.ANTHROPIC_API_KEY !== undefined) {
      if (envVars.ANTHROPIC_API_KEY === '') {
        original.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
        env.ANTHROPIC_API_KEY = '';
      } else if (options.preserveApiKey) {
        original.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
        env.ANTHROPIC_API_KEY = envVars.ANTHROPIC_API_KEY;
      } else {
        original.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN;
        env.ANTHROPIC_AUTH_TOKEN = envVars.ANTHROPIC_API_KEY;
      }
    }
    for (const [key, emptyDeletes] of PROVIDER_ROUTING_ENV) set(key, emptyDeletes);

    this.saveClearDaemonPortEnvVars(original, env);

    return original;
  }

  private clearProviderRoutingEnvVars(
    options: { preserveUserSettings?: boolean } = {},
    env: NodeJS.ProcessEnv = process.env
  ): OriginalEnvVars {
    const original: OriginalEnvVars = {};
    let changed = false;

    const clear = (key: keyof OriginalEnvVars): void => {
      original[key] = env[key];
      if (env[key] !== undefined) {
        delete env[key];
        changed = true;
      }
    };

    clear('ANTHROPIC_AUTH_TOKEN');

    for (const [key, userValue] of userPreservableRoutingEnv()) {
      const value = env[key];
      if (value === undefined) continue;
      original[key] = value;
      changed = true;
      if (!keepsRoutingEnv(key, value, userValue, options.preserveUserSettings)) delete env[key];
    }

    this.saveClearDaemonPortEnvVars(original, env);
    changed =
      changed ||
      original.PORT !== undefined ||
      original.HYPERNEO_PORT !== undefined ||
      original.NEOKAI_PORT !== undefined;

    return changed ? original : {};
  }

  private saveClearDaemonPortEnvVars(
    original: OriginalEnvVars,
    env: NodeJS.ProcessEnv = process.env
  ): void {
    original.PORT = env.PORT;
    delete env.PORT;
    original.HYPERNEO_PORT = env.HYPERNEO_PORT;
    delete env.HYPERNEO_PORT;
    original.NEOKAI_PORT = env.NEOKAI_PORT;
    delete env.NEOKAI_PORT;
  }

  restoreEnvVars(original: OriginalEnvVars): void {
    for (const [key, value] of Object.entries(original)) {
      if (value !== undefined) process.env[key] = value;
      else delete process.env[key];
    }
  }

  async isGlmAvailable(): Promise<boolean> {
    return this.isProviderAvailable('glm');
  }
}

const PROVIDER_SERVICE_KEY = Symbol.for('hyperneo:providerServiceInstance');

function isDevProxyActive(): boolean {
  return process.env.HYPERNEO_USE_DEV_PROXY === '1';
}

function isLocalDevProxyUrl(url: string | undefined): boolean {
  if (!isDevProxyActive()) return false;
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}

const userConfiguredBaseUrl = process.env.ANTHROPIC_BASE_URL;
const userConfiguredApiTimeout = process.env.API_TIMEOUT_MS;
const userConfiguredDisableNonEssentialTraffic =
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
const userConfiguredAutoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
const userConfiguredAnthropicModel = process.env.ANTHROPIC_MODEL;
const userConfiguredSubagentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL;
const userConfiguredToolSearch = process.env.ENABLE_TOOL_SEARCH;
const userConfiguredDefaultSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
const userConfiguredDefaultHaikuModel = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
const userConfiguredDefaultOpusModel = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
const userConfiguredCustomHeaders = process.env.ANTHROPIC_CUSTOM_HEADERS;

type ProviderEnvKey = keyof OriginalEnvVars & keyof ProviderEnvVars;

const PROVIDER_AUTH_ENV: ReadonlyArray<readonly [ProviderEnvKey, boolean]> = [
  ['CLAUDE_CODE_OAUTH_TOKEN', true],
  ['ANTHROPIC_AUTH_TOKEN', false],
];

const PROVIDER_ROUTING_ENV: ReadonlyArray<readonly [ProviderEnvKey, boolean]> = [
  ['ANTHROPIC_BASE_URL', false],
  ['ANTHROPIC_MODEL', false],
  ['CLAUDE_CODE_SUBAGENT_MODEL', false],
  ['ENABLE_TOOL_SEARCH', false],
  ['API_TIMEOUT_MS', false],
  ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', false],
  ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', true],
  ['ANTHROPIC_CUSTOM_HEADERS', true],
  ['ANTHROPIC_DEFAULT_SONNET_MODEL', false],
  ['ANTHROPIC_DEFAULT_HAIKU_MODEL', false],
  ['ANTHROPIC_DEFAULT_OPUS_MODEL', false],
];

function userPreservableRoutingEnv(): ReadonlyArray<readonly [ProviderEnvKey, string | undefined]> {
  return [
    ['ANTHROPIC_MODEL', userConfiguredAnthropicModel],
    ['CLAUDE_CODE_SUBAGENT_MODEL', userConfiguredSubagentModel],
    ['ENABLE_TOOL_SEARCH', userConfiguredToolSearch],
    ['ANTHROPIC_BASE_URL', userConfiguredBaseUrl],
    ['API_TIMEOUT_MS', userConfiguredApiTimeout],
    ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', userConfiguredDisableNonEssentialTraffic],
    ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', userConfiguredAutoCompactWindow],
    ['ANTHROPIC_CUSTOM_HEADERS', userConfiguredCustomHeaders],
    ['ANTHROPIC_DEFAULT_SONNET_MODEL', userConfiguredDefaultSonnetModel],
    ['ANTHROPIC_DEFAULT_HAIKU_MODEL', userConfiguredDefaultHaikuModel],
    ['ANTHROPIC_DEFAULT_OPUS_MODEL', userConfiguredDefaultOpusModel],
  ];
}

export function keepsRoutingEnv(
  key: string,
  value: string,
  userValue: string | undefined,
  preserveUserSettings: boolean | undefined
): boolean {
  if (key === 'ANTHROPIC_BASE_URL' && isLocalDevProxyUrl(value)) return true;
  return !!preserveUserSettings && userValue !== undefined && value === userValue;
}

export function getUserConfiguredAnthropicEnv(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const entries: Array<[string, string | undefined]> = [
    ['ANTHROPIC_BASE_URL', userConfiguredBaseUrl],
    ['ANTHROPIC_MODEL', userConfiguredAnthropicModel],
    ['CLAUDE_CODE_SUBAGENT_MODEL', userConfiguredSubagentModel],
    ['ENABLE_TOOL_SEARCH', userConfiguredToolSearch],
    ['API_TIMEOUT_MS', userConfiguredApiTimeout],
    ['ANTHROPIC_DEFAULT_SONNET_MODEL', userConfiguredDefaultSonnetModel],
    ['ANTHROPIC_DEFAULT_HAIKU_MODEL', userConfiguredDefaultHaikuModel],
    ['ANTHROPIC_DEFAULT_OPUS_MODEL', userConfiguredDefaultOpusModel],
    ['ANTHROPIC_CUSTOM_HEADERS', userConfiguredCustomHeaders],
    ['ANTHROPIC_AUTH_TOKEN', process.env.ANTHROPIC_AUTH_TOKEN],
    ['CLAUDE_CODE_OAUTH_TOKEN', process.env.CLAUDE_CODE_OAUTH_TOKEN],
  ];
  for (const [key, value] of entries) {
    if (value !== undefined) snapshot[key] = value;
  }
  return snapshot;
}

export function getProviderService(): ProviderService {
  if (!(globalThis as Record<symbol, unknown>)[PROVIDER_SERVICE_KEY]) {
    (globalThis as Record<symbol, unknown>)[PROVIDER_SERVICE_KEY] = new ProviderService();
  }
  return (globalThis as Record<symbol, unknown>)[PROVIDER_SERVICE_KEY] as ProviderService;
}

export function resetProviderServiceInstance(): void {
  delete (globalThis as Record<symbol, unknown>)[PROVIDER_SERVICE_KEY];
}

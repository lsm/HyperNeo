import type { ModelInfo, Provider, ProviderInfo, Session } from '@hyperneo/shared';
import type {
  ProviderInfo as NewProviderInfo,
  ProviderSessionConfig,
  ProviderSdkConfig,
  Provider as RegisteredProvider,
} from '@hyperneo/shared/provider';
import { Logger } from './logger.js';
import {
  getCuratedModelIds,
  getProviderCatalogModels,
  resolveVisibleCanonicalModelId,
} from './model-service.js';
import { initializeProviders, waitForOptionalProviderRegistration } from './providers/factory.js';
import { providerSessionConfigForSession } from './providers/session-config.js';

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
  CLAUDE_AGENT_SDK_CLIENT_APP?: string;
  PORT?: string;
  HYPERNEO_PORT?: string;
  NEOKAI_PORT?: string;
}

function mergeOriginalEnvVars(...originals: OriginalEnvVars[]): OriginalEnvVars {
  const merged: OriginalEnvVars = {};
  for (const original of originals) {
    for (const [key, value] of Object.entries(original)) {
      if (!Object.prototype.hasOwnProperty.call(merged, key)) {
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

  async ensureSessionProviderBridges(session: Session): Promise<void> {
    await this.getReadyRegistry();
    const registry = this.getRegistry();
    const providerId = session.config.provider || 'anthropic';
    const provider = registry.get(providerId);
    if (!provider) return;
    await this.ensureProviderBridges(
      provider,
      session.config.model || 'default',
      providerSessionConfigForSession(session)
    );
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

  private async getProviderCatalogModels(
    providerId: string,
    provider: RegisteredProvider
  ): Promise<ModelInfo[]> {
    return getProviderCatalogModels(providerId, provider);
  }

  private async resolveVisibleCuratedModel(
    providerId: string,
    provider: RegisteredProvider,
    ...candidates: Array<string | undefined>
  ): Promise<string | undefined> {
    const registry = this.getRegistry();
    if (registry.getCuratedModels(providerId) === undefined) {
      const preferred = candidates.find((candidate) => candidate !== undefined);
      if (preferred !== undefined) {
        return preferred;
      }
      const catalogModels = await this.getProviderCatalogModels(providerId, provider);
      return catalogModels[0]?.id;
    }
    const catalogModels = await this.getProviderCatalogModels(providerId, provider);
    const catalogIds = new Set(catalogModels.map((model) => model.id));
    for (const candidate of candidates) {
      if (!candidate) continue;
      const canonicalId =
        (await resolveVisibleCanonicalModelId(candidate, providerId, 'global', catalogModels)) ??
        candidate;
      const curatedEntries = registry.getCuratedModels(providerId);
      if (curatedEntries === undefined) {
        return candidate;
      }
      let allowed = getCuratedModelIds(providerId)?.has(canonicalId) ?? false;
      if (!allowed) {
        for (const entry of curatedEntries) {
          const entryCanonical =
            (await resolveVisibleCanonicalModelId(entry.id, providerId, 'global', catalogModels)) ??
            entry.id;
          if (entryCanonical === canonicalId) {
            allowed = true;
            break;
          }
        }
      }
      if (!allowed) continue;
      if (!catalogIds.has(canonicalId)) continue;
      return candidate;
    }
    const curatedAfter = registry.getCuratedModels(providerId);
    if (curatedAfter === undefined) {
      return catalogModels[0]?.id;
    }
    for (const entry of curatedAfter) {
      const canonical =
        (await resolveVisibleCanonicalModelId(entry.id, providerId, 'global', catalogModels)) ??
        entry.id;
      if (catalogIds.has(canonical)) {
        return canonical;
      }
    }
    return undefined;
  }

  async getTitleGenerationModels(
    providerId: string,
    sessionModelId: string
  ): Promise<{ providerModelId: string; sdkModelId: string } | null> {
    const registry = await this.getReadyRegistry();
    const provider = registry.get(providerId);
    const titleOverride = provider?.getTitleGenerationModel?.();
    let providerModelId = titleOverride ?? sessionModelId;
    if (provider) {
      const resolved = await this.resolveVisibleCuratedModel(
        providerId,
        provider,
        titleOverride,
        sessionModelId
      );
      if (!resolved) return null;
      providerModelId = resolved;
    }
    let sdkModelId = provider?.translateModelIdForSdk?.(providerModelId) ?? providerModelId;
    await this.ensureProviderBridges(provider, providerModelId);
    try {
      const sdkConfig = provider?.buildSdkConfig(providerModelId);
      sdkModelId = sdkConfig?.envVars.ANTHROPIC_MODEL ?? sdkModelId;
    } catch {}
    return {
      providerModelId,
      sdkModelId,
    };
  }

  async getCheapTierModel(providerId: string): Promise<string | null> {
    const registry = await this.getReadyRegistry();
    const provider = registry.get(providerId);
    if (!provider) return null;
    const preferred = await this.resolveVisibleCuratedModel(
      providerId,
      provider,
      provider.getTitleGenerationModel?.(),
      provider.getModelForTier?.('haiku')
    );
    return preferred ?? null;
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
    let modelId = await this.resolveVisibleCuratedModel(
      providerId,
      provider,
      titleOverride,
      tierFallback
    );
    if (!modelId) {
      if (registry.getCuratedModels(providerId) !== undefined) return null;
      modelId = 'default';
    }

    let baseUrl = 'https://api.anthropic.com';
    let apiVersion = 'v1';
    await this.ensureProviderBridges(provider, modelId);
    try {
      const sdkConfig = provider.buildSdkConfig(modelId);
      modelId = sdkConfig.envVars.ANTHROPIC_MODEL ?? modelId;
      baseUrl = (sdkConfig.envVars.ANTHROPIC_BASE_URL as string | undefined) || baseUrl;
      apiVersion = sdkConfig.apiVersion || apiVersion;
    } catch (err) {
      this.logger.warn(
        `[ProviderService] getTitleGenerationConfig: buildSdkConfig failed for provider` +
          ` '${providerId}' — falling back to Anthropic defaults. Cause: ${err}`
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
      const sdkConfig = provider.buildSdkConfig(modelId, sessionConfig);
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

  applyEnvVarsToProcessForSession(session: Session): OriginalEnvVars {
    const envVars = this.getProviderEnvVars(session);
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

  async applyEnvVarsToProcess(modelId: string, providerId: string): Promise<OriginalEnvVars> {
    const envVars = await this.getEnvVarsForModel(modelId, providerId);
    const cleared = this.clearProviderRoutingEnvVars({
      preserveUserSettings: providerId === 'anthropic',
    });

    if (Object.keys(envVars).length === 0) {
      return cleared;
    }

    return mergeOriginalEnvVars(
      cleared,
      this.applyEnvVars(envVars, { preserveApiKey: providerId === 'anthropic' })
    );
  }

  async applyEnvVarsToProcessForProvider(
    providerId: string,
    modelId?: string
  ): Promise<OriginalEnvVars> {
    await this.getReadyRegistry();
    const registry = this.getRegistry();
    const provider = registry.get(providerId);

    if (!provider) {
      return {};
    }
    if (providerId === 'anthropic') {
      const envVars = sdkConfigToEnvVars(provider.buildSdkConfig(modelId || 'default'));
      const cleared = this.clearProviderRoutingEnvVars({ preserveUserSettings: true });
      if (Object.keys(envVars).length === 0) {
        return cleared;
      }
      return mergeOriginalEnvVars(cleared, this.applyEnvVars(envVars, { preserveApiKey: true }));
    }

    const sessionConfig = modelId ? { apiKey: undefined } : undefined;
    let sdkConfig: ProviderSdkConfig;
    try {
      await this.ensureProviderBridges(provider, modelId || 'default', sessionConfig);
      sdkConfig = provider.buildSdkConfig(modelId || 'default', sessionConfig);
    } catch {
      return {};
    }
    const envVars = sdkConfigToEnvVars(sdkConfig);
    const cleared = this.clearProviderRoutingEnvVars({ preserveUserSettings: false });

    if (Object.keys(envVars).length === 0) {
      return cleared;
    }

    return mergeOriginalEnvVars(
      cleared,
      this.applyEnvVars(envVars, { preserveApiKey: providerId === 'anthropic' })
    );
  }

  private applyEnvVars(
    envVars: ProviderEnvVars,
    options: { preserveApiKey?: boolean } = {}
  ): OriginalEnvVars {
    const original: OriginalEnvVars = {};

    if (envVars.CLAUDE_CODE_OAUTH_TOKEN !== undefined) {
      original.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (envVars.CLAUDE_CODE_OAUTH_TOKEN === '') {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      } else {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = envVars.CLAUDE_CODE_OAUTH_TOKEN;
      }
    }
    if (envVars.ANTHROPIC_AUTH_TOKEN !== undefined) {
      original.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
      process.env.ANTHROPIC_AUTH_TOKEN = envVars.ANTHROPIC_AUTH_TOKEN;
    }
    if (envVars.ANTHROPIC_API_KEY !== undefined) {
      if (envVars.ANTHROPIC_API_KEY === '') {
        original.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = '';
      } else if (options.preserveApiKey) {
        original.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = envVars.ANTHROPIC_API_KEY;
      } else {
        original.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
        process.env.ANTHROPIC_AUTH_TOKEN = envVars.ANTHROPIC_API_KEY;
      }
    }
    if (envVars.ANTHROPIC_BASE_URL !== undefined) {
      original.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
      process.env.ANTHROPIC_BASE_URL = envVars.ANTHROPIC_BASE_URL;
    }
    if (envVars.ANTHROPIC_MODEL !== undefined) {
      original.ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL;
      process.env.ANTHROPIC_MODEL = envVars.ANTHROPIC_MODEL;
    }
    if (envVars.CLAUDE_CODE_SUBAGENT_MODEL !== undefined) {
      original.CLAUDE_CODE_SUBAGENT_MODEL = process.env.CLAUDE_CODE_SUBAGENT_MODEL;
      process.env.CLAUDE_CODE_SUBAGENT_MODEL = envVars.CLAUDE_CODE_SUBAGENT_MODEL;
    }
    if (envVars.ENABLE_TOOL_SEARCH !== undefined) {
      original.ENABLE_TOOL_SEARCH = process.env.ENABLE_TOOL_SEARCH;
      process.env.ENABLE_TOOL_SEARCH = envVars.ENABLE_TOOL_SEARCH;
    }
    if (envVars.API_TIMEOUT_MS !== undefined) {
      original.API_TIMEOUT_MS = process.env.API_TIMEOUT_MS;
      process.env.API_TIMEOUT_MS = envVars.API_TIMEOUT_MS;
    }
    if (envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC !== undefined) {
      original.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC =
        process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
      process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC =
        envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    }
    if (envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== undefined) {
      original.CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      if (envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW === '') {
        delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      } else {
        process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      }
    }
    if (envVars.ANTHROPIC_DEFAULT_SONNET_MODEL !== undefined) {
      original.ANTHROPIC_DEFAULT_SONNET_MODEL = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = envVars.ANTHROPIC_DEFAULT_SONNET_MODEL;
    }
    if (envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL !== undefined) {
      original.ANTHROPIC_DEFAULT_HAIKU_MODEL = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    }
    if (envVars.ANTHROPIC_DEFAULT_OPUS_MODEL !== undefined) {
      original.ANTHROPIC_DEFAULT_OPUS_MODEL = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = envVars.ANTHROPIC_DEFAULT_OPUS_MODEL;
    }

    this.saveClearDaemonPortEnvVars(original);

    return original;
  }

  private clearProviderRoutingEnvVars(
    options: { preserveUserSettings?: boolean } = {}
  ): OriginalEnvVars {
    const original: OriginalEnvVars = {};
    let changed = false;

    const clear = (key: keyof OriginalEnvVars): void => {
      original[key] = process.env[key];
      if (process.env[key] !== undefined) {
        delete process.env[key];
        changed = true;
      }
    };

    clear('ANTHROPIC_AUTH_TOKEN');

    if (process.env.ANTHROPIC_MODEL !== undefined) {
      original.ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL;
      changed = true;
      if (
        !options.preserveUserSettings ||
        userConfiguredAnthropicModel === undefined ||
        process.env.ANTHROPIC_MODEL !== userConfiguredAnthropicModel
      ) {
        delete process.env.ANTHROPIC_MODEL;
      }
    }

    if (process.env.CLAUDE_CODE_SUBAGENT_MODEL !== undefined) {
      original.CLAUDE_CODE_SUBAGENT_MODEL = process.env.CLAUDE_CODE_SUBAGENT_MODEL;
      changed = true;
      if (
        !options.preserveUserSettings ||
        userConfiguredSubagentModel === undefined ||
        process.env.CLAUDE_CODE_SUBAGENT_MODEL !== userConfiguredSubagentModel
      ) {
        delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
      }
    }
    if (process.env.ENABLE_TOOL_SEARCH !== undefined) {
      original.ENABLE_TOOL_SEARCH = process.env.ENABLE_TOOL_SEARCH;
      changed = true;
      if (
        !options.preserveUserSettings ||
        userConfiguredToolSearch === undefined ||
        process.env.ENABLE_TOOL_SEARCH !== userConfiguredToolSearch
      ) {
        delete process.env.ENABLE_TOOL_SEARCH;
      }
    }

    if (process.env.ANTHROPIC_BASE_URL !== undefined) {
      original.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
      changed = true;
      if (
        !isLocalDevProxyUrl(process.env.ANTHROPIC_BASE_URL) &&
        (!options.preserveUserSettings ||
          userConfiguredBaseUrl === undefined ||
          process.env.ANTHROPIC_BASE_URL !== userConfiguredBaseUrl)
      ) {
        delete process.env.ANTHROPIC_BASE_URL;
      }
    }

    if (process.env.API_TIMEOUT_MS !== undefined) {
      original.API_TIMEOUT_MS = process.env.API_TIMEOUT_MS;
      changed = true;
      if (
        !options.preserveUserSettings ||
        userConfiguredApiTimeout === undefined ||
        process.env.API_TIMEOUT_MS !== userConfiguredApiTimeout
      ) {
        delete process.env.API_TIMEOUT_MS;
      }
    }

    if (process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC !== undefined) {
      original.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC =
        process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
      changed = true;
      if (
        !options.preserveUserSettings ||
        userConfiguredDisableNonEssentialTraffic === undefined ||
        process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC !==
          userConfiguredDisableNonEssentialTraffic
      ) {
        delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
      }
    }

    if (process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== undefined) {
      original.CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      changed = true;
      if (
        !options.preserveUserSettings ||
        userConfiguredAutoCompactWindow === undefined ||
        process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== userConfiguredAutoCompactWindow
      ) {
        delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      }
    }

    if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL !== undefined) {
      original.ANTHROPIC_DEFAULT_SONNET_MODEL = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
      changed = true;
      if (
        !options.preserveUserSettings ||
        userConfiguredDefaultSonnetModel === undefined ||
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL !== userConfiguredDefaultSonnetModel
      ) {
        delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
      }
    }

    if (process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL !== undefined) {
      original.ANTHROPIC_DEFAULT_HAIKU_MODEL = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      changed = true;
      if (
        !options.preserveUserSettings ||
        userConfiguredDefaultHaikuModel === undefined ||
        process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL !== userConfiguredDefaultHaikuModel
      ) {
        delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      }
    }

    if (process.env.ANTHROPIC_DEFAULT_OPUS_MODEL !== undefined) {
      original.ANTHROPIC_DEFAULT_OPUS_MODEL = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
      changed = true;
      if (
        !options.preserveUserSettings ||
        userConfiguredDefaultOpusModel === undefined ||
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL !== userConfiguredDefaultOpusModel
      ) {
        delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
      }
    }

    this.saveClearDaemonPortEnvVars(original);
    changed =
      changed ||
      original.PORT !== undefined ||
      original.HYPERNEO_PORT !== undefined ||
      original.NEOKAI_PORT !== undefined;

    return changed ? original : {};
  }

  private saveClearDaemonPortEnvVars(original: OriginalEnvVars): void {
    original.PORT = process.env.PORT;
    delete process.env.PORT;
    original.HYPERNEO_PORT = process.env.HYPERNEO_PORT;
    delete process.env.HYPERNEO_PORT;
    original.NEOKAI_PORT = process.env.NEOKAI_PORT;
    delete process.env.NEOKAI_PORT;
  }

  restoreEnvVars(original: OriginalEnvVars): void {
    if (Object.keys(original).length === 0) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(original, 'ANTHROPIC_API_KEY')) {
      if (original.ANTHROPIC_API_KEY !== undefined) {
        process.env.ANTHROPIC_API_KEY = original.ANTHROPIC_API_KEY;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
    if (Object.prototype.hasOwnProperty.call(original, 'ANTHROPIC_AUTH_TOKEN')) {
      if (original.ANTHROPIC_AUTH_TOKEN !== undefined) {
        process.env.ANTHROPIC_AUTH_TOKEN = original.ANTHROPIC_AUTH_TOKEN;
      } else {
        delete process.env.ANTHROPIC_AUTH_TOKEN;
      }
    }
    if (Object.prototype.hasOwnProperty.call(original, 'CLAUDE_CODE_OAUTH_TOKEN')) {
      if (original.CLAUDE_CODE_OAUTH_TOKEN !== undefined) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = original.CLAUDE_CODE_OAUTH_TOKEN;
      } else {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      }
    }
    if (Object.prototype.hasOwnProperty.call(original, 'ANTHROPIC_BASE_URL')) {
      if (original.ANTHROPIC_BASE_URL !== undefined) {
        process.env.ANTHROPIC_BASE_URL = original.ANTHROPIC_BASE_URL;
      } else {
        delete process.env.ANTHROPIC_BASE_URL;
      }
    }
    if (Object.prototype.hasOwnProperty.call(original, 'ANTHROPIC_MODEL')) {
      if (original.ANTHROPIC_MODEL !== undefined) {
        process.env.ANTHROPIC_MODEL = original.ANTHROPIC_MODEL;
      } else {
        delete process.env.ANTHROPIC_MODEL;
      }
    }
    if (Object.prototype.hasOwnProperty.call(original, 'CLAUDE_CODE_SUBAGENT_MODEL')) {
      if (original.CLAUDE_CODE_SUBAGENT_MODEL !== undefined) {
        process.env.CLAUDE_CODE_SUBAGENT_MODEL = original.CLAUDE_CODE_SUBAGENT_MODEL;
      } else {
        delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
      }
    }
    if (Object.prototype.hasOwnProperty.call(original, 'ENABLE_TOOL_SEARCH')) {
      if (original.ENABLE_TOOL_SEARCH !== undefined) {
        process.env.ENABLE_TOOL_SEARCH = original.ENABLE_TOOL_SEARCH;
      } else {
        delete process.env.ENABLE_TOOL_SEARCH;
      }
    }
    if (Object.prototype.hasOwnProperty.call(original, 'API_TIMEOUT_MS')) {
      if (original.API_TIMEOUT_MS !== undefined) {
        process.env.API_TIMEOUT_MS = original.API_TIMEOUT_MS;
      } else {
        delete process.env.API_TIMEOUT_MS;
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(original, 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
    ) {
      if (original.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC !== undefined) {
        process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC =
          original.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
      } else {
        delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
      }
    }
    if (Object.prototype.hasOwnProperty.call(original, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW')) {
      if (original.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== undefined) {
        process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = original.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      } else {
        delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      }
    }
    if (Object.prototype.hasOwnProperty.call(original, 'ANTHROPIC_DEFAULT_SONNET_MODEL')) {
      if (original.ANTHROPIC_DEFAULT_SONNET_MODEL !== undefined) {
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = original.ANTHROPIC_DEFAULT_SONNET_MODEL;
      } else {
        delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
      }
    }
    if (Object.prototype.hasOwnProperty.call(original, 'ANTHROPIC_DEFAULT_HAIKU_MODEL')) {
      if (original.ANTHROPIC_DEFAULT_HAIKU_MODEL !== undefined) {
        process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = original.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      } else {
        delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      }
    }
    if (Object.prototype.hasOwnProperty.call(original, 'ANTHROPIC_DEFAULT_OPUS_MODEL')) {
      if (original.ANTHROPIC_DEFAULT_OPUS_MODEL !== undefined) {
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = original.ANTHROPIC_DEFAULT_OPUS_MODEL;
      } else {
        delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
      }
    }
    if (Object.prototype.hasOwnProperty.call(original, 'CLAUDE_AGENT_SDK_CLIENT_APP')) {
      if (original.CLAUDE_AGENT_SDK_CLIENT_APP !== undefined) {
        process.env.CLAUDE_AGENT_SDK_CLIENT_APP = original.CLAUDE_AGENT_SDK_CLIENT_APP;
      } else {
        delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP;
      }
    }
    if (Object.prototype.hasOwnProperty.call(original, 'PORT')) {
      if (original.PORT !== undefined) {
        process.env.PORT = original.PORT;
      } else {
        delete process.env.PORT;
      }
    }
    if (Object.prototype.hasOwnProperty.call(original, 'HYPERNEO_PORT')) {
      if (original.HYPERNEO_PORT !== undefined) {
        process.env.HYPERNEO_PORT = original.HYPERNEO_PORT;
      } else {
        delete process.env.HYPERNEO_PORT;
      }
    }
    if (Object.prototype.hasOwnProperty.call(original, 'NEOKAI_PORT')) {
      if (original.NEOKAI_PORT !== undefined) {
        process.env.NEOKAI_PORT = original.NEOKAI_PORT;
      } else {
        delete process.env.NEOKAI_PORT;
      }
    }
  }

  async isGlmAvailable(): Promise<boolean> {
    return this.isProviderAvailable('glm');
  }
}

export function mergeProviderEnvVars(providerEnvVars: ProviderEnvVars): NodeJS.ProcessEnv {
  return { ...process.env, ...providerEnvVars };
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

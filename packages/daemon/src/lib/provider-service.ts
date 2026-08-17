/**
 * ProviderService - Provider operations and environment variable management
 *
 * This file serves two purposes:
 *
 * 1. **Compatibility Layer** - Delegates provider operations to the provider registry.
 *    The new provider system is in `packages/daemon/src/lib/providers/`.
 *    Methods like `getDefaultProvider()` etc. delegate to the registry.
 *
 * 2. **Process-level Environment Management** - Handles process.env manipulation.
 *    Methods like `applyEnvVarsToProcess()` and `restoreEnvVars()` modify process.env
 *    before SDK query creation. This is necessary because:
 *    - The SDK subprocess inherits environment variables when spawned
 *    - Provider-specific env vars (ANTHROPIC_BASE_URL, API keys) must be set in the parent process
 *    - This cannot be handled by ProviderContext or options.env alone
 *
 * ## User Settings Override Behavior
 *
 * When users configure custom env vars in ~/.Claude/settings.json:
 *
 * 1. **Non-provider env vars** (e.g., custom tool vars) are passed through to the SDK
 *    - Read from globalSettings.env in query-options-builder.ts via getMergedEnvironmentVars()
 *    - Merged with session.config.env (session takes precedence)
 *    - Passed to SDK via options.env
 *
 * 2. **Provider-specific env vars** are managed by the provider system:
 *    - ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN
 *    - ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_*_MODEL (tier mappings)
 *    - API_TIMEOUT_MS, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
 *    - These are filtered out from user settings
 *    - Applied to process.env by applyEnvVarsToProcess()
 *    - Always OVERRIDE user settings to ensure provider works correctly
 *
 * This ensures that when a user selects "glm-5" model:
 * - GLM's ANTHROPIC_BASE_URL points to GLM's endpoint (not user's custom Anthropic endpoint)
 * - GLM's API key is used (not user's Anthropic key)
 * - User's other custom env vars are still passed through
 *
 * Architecture:
 * - Provider registry (providers/) - Provider definitions, model lists, SDK config
 * - ProviderContext - Per-session provider configuration
 * - ProviderService (this file) - Process-level env var management + legacy API compatibility
 *
 * This file should NOT be removed - it provides essential process-level functionality
 * that cannot be moved to the provider registry.
 */

import type { Provider, ProviderInfo, Session } from '@hyperneo/shared';
import type { ProviderInfo as NewProviderInfo, ProviderSdkConfig } from '@hyperneo/shared/provider';
import { Logger } from './logger.js';
import { initializeProviders, waitForOptionalProviderRegistration } from './providers/factory.js';

/**
 * Convert new ProviderInfo to legacy ProviderInfo
 */
function toLegacyProviderInfo(newInfo: NewProviderInfo): ProviderInfo {
  return {
    id: newInfo.id as Provider,
    name: newInfo.name,
    baseUrl: undefined, // Legacy field, not used in new system
    models: newInfo.models,
    available: newInfo.available,
  };
}

/**
 * Provider-controlled vars that are not ANTHROPIC_*-prefixed.
 *
 * Unlike the ANTHROPIC_* routing vars, these are forwarded into options.env
 * for non-Anthropic sessions (provider's own value only — see
 * getMergedEnvironmentVars in query-options-builder.ts) and treated as
 * provider-managed extras during the post-apply env refresh in query-runner.
 * Single source of truth so the two call sites cannot drift.
 */
export const NON_ANTHROPIC_PREFIX_PROVIDER_VARS = [
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'ENABLE_TOOL_SEARCH',
] as const;

/**
 * Environment variables for provider routing
 *
 * IMPORTANT: These must be set in process.env (parent process) before SDK query creation.
 * The SDK subprocess inherits these environment variables when spawned.
 * Passing via options.env does NOT work for GLM.
 */
export interface ProviderEnvVars {
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_MODEL?: string; // Override default model
  CLAUDE_CODE_SUBAGENT_MODEL?: string; // Override subagent model
  ENABLE_TOOL_SEARCH?: string; // Provider-specific SDK flag
  ANTHROPIC_DEFAULT_HAIKU_MODEL?: string; // Map haiku tier to provider model
  ANTHROPIC_DEFAULT_SONNET_MODEL?: string; // Map default/sonnet tier to provider model
  ANTHROPIC_DEFAULT_OPUS_MODEL?: string; // Map opus tier to provider model
  API_TIMEOUT_MS?: string;
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC?: string;
  CLAUDE_CODE_AUTO_COMPACT_WINDOW?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  [key: string]: string | undefined; // Index signature for SDK env option compatibility
}

/**
 * Stores original environment variable values for restoration.
 *
 * Exported so callers (e.g. query-runner.ts) can use the same type
 * rather than maintaining a parallel definition that diverges over time.
 */
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
  /** Daemon's listening PORT — cleared from subprocess env to prevent kill-chain via lsof */
  PORT?: string;
  /** Daemon's HYPERNEO_PORT — also cleared to prevent subprocess env leakage */
  HYPERNEO_PORT?: string;
  /** Legacy NEOKAI_PORT — also cleared so stale legacy deployments do not leak the daemon port */
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

/**
 * Convert ProviderSdkConfig to ProviderEnvVars
 *
 * The new provider system returns ProviderSdkConfig with envVars and sdkOptions.
 * We need to convert this to the legacy ProviderEnvVars format.
 */
function sdkConfigToEnvVars(sdkConfig: ProviderSdkConfig): ProviderEnvVars {
  const envVars: ProviderEnvVars = { ...sdkConfig.envVars };

  // Add sdkOptions as ANTHROPIC_* env vars if they exist
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

  /**
   * Ensure provider system is initialized
   */
  private getRegistry() {
    return initializeProviders();
  }

  private async getReadyRegistry() {
    const registry = this.getRegistry();
    await waitForOptionalProviderRegistration(registry);
    return registry;
  }

  /**
   * Get the default provider based on environment configuration
   *
   * Delegates to registry.getDefaultProvider()
   */
  async getDefaultProvider(): Promise<Provider> {
    const registry = await this.getReadyRegistry();
    const provider = await registry.getDefaultProvider();
    return provider.id as Provider;
  }

  /**
   * Get API key for a specific provider from environment variables
   *
   * TODO: This should be replaced by checking provider.isAvailable()
   * and using session.config.providerConfig.apiKey for overrides
   */
  getProviderApiKey(providerId: Provider): string | undefined {
    const registry = this.getRegistry();
    const provider = registry.get(providerId);

    if (!provider) {
      return undefined;
    }

    // Check provider-specific env vars
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

  /**
   * Check if a provider is available (has API key configured)
   *
   * Delegates to provider.isAvailable()
   */
  async isProviderAvailable(providerId: string): Promise<boolean> {
    const registry = await this.getReadyRegistry();
    const provider = registry.get(providerId);

    if (!provider) {
      return false;
    }

    return await provider.isAvailable();
  }

  /**
   * Get provider information
   *
   * Delegates to registry.getProviderInfo()
   */
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

    // Build base URL from SDK config.
    // buildSdkConfig may throw for providers that require lazy initialisation
    // (e.g. AnthropicToCopilotBridgeProvider throws when the embedded server has not
    // been started yet).  Treat that as "no base URL" rather than a crash.
    let baseUrl: string | undefined;
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

  /**
   * List all available providers (those with API keys configured)
   *
   * Delegates to registry.getProviderInfo()
   */
  async getAvailableProviders(): Promise<ProviderInfo[]> {
    const registry = await this.getReadyRegistry();
    const newProviderInfos = await registry.getProviderInfo();
    return newProviderInfos.map(toLegacyProviderInfo);
  }

  /**
   * Validate that a provider switch is possible
   *
   * Delegates to registry.validateProviderSwitch()
   */
  async validateProviderSwitch(
    providerId: Provider,
    apiKey?: string
  ): Promise<{ valid: boolean; error?: string }> {
    const registry = await this.getReadyRegistry();
    return await registry.validateProviderSwitch(providerId, apiKey);
  }

  /**
   * Get the default model for a provider
   */
  async getDefaultModelForProvider(providerId: Provider): Promise<string> {
    const registry = await this.getReadyRegistry();
    const provider = registry.get(providerId);

    if (!provider) {
      return 'default';
    }

    const models = await provider.getModels();
    return models[0]?.id || 'default';
  }

  /**
   * Get provider-facing and SDK-facing models for title generation.
   * Defaults to the session model unless the provider declares an override.
   * Provider-specific IDs are translated to SDK-compatible model names.
   */
  async getTitleGenerationModels(
    providerId: string,
    sessionModelId: string
  ): Promise<{ providerModelId: string; sdkModelId: string }> {
    const registry = await this.getReadyRegistry();
    const provider = registry.get(providerId);
    const providerModelId = provider?.getTitleGenerationModel?.() ?? sessionModelId;
    let sdkModelId = provider?.translateModelIdForSdk?.(providerModelId) ?? providerModelId;
    try {
      const sdkConfig = provider?.buildSdkConfig(providerModelId);
      sdkModelId = sdkConfig?.envVars.ANTHROPIC_MODEL ?? sdkModelId;
    } catch {
      // Provider not initialised yet; keep translated fallback.
    }
    return {
      providerModelId,
      sdkModelId,
    };
  }

  async getTitleGenerationModel(providerId: string, sessionModelId: string): Promise<string> {
    const { sdkModelId } = await this.getTitleGenerationModels(providerId, sessionModelId);
    return sdkModelId;
  }

  /**
   * Get title generation configuration for a provider
   * Returns the model ID, base URL, and API version to use for direct API calls
   */
  async getTitleGenerationConfig(providerId: string): Promise<{
    modelId: string;
    baseUrl: string;
    apiVersion: string;
  }> {
    const registry = await this.getReadyRegistry();
    const provider = registry.get(providerId);

    if (!provider) {
      // Fallback to Anthropic
      return {
        modelId: 'haiku',
        baseUrl: 'https://api.anthropic.com',
        apiVersion: 'v1',
      };
    }

    // Resolve the title-model override BEFORE calling getModels() so providers
    // that probe upstream in getModels() (Kimi, GLM, MiniMax, Codex, ACP,
    // Custom Endpoint) don't fire a network request just to compute a
    // title-model fallback we won't actually use. The models list is only
    // fetched when neither override nor tier fallback produced an answer.
    const titleOverride = provider.getTitleGenerationModel?.();
    const tierFallback = provider.getModelForTier('haiku');
    let modelId = titleOverride || tierFallback || (await provider.getModels())[0]?.id || 'default';

    // Get base URL from SDK config
    let baseUrl = 'https://api.anthropic.com';
    let apiVersion = 'v1';
    try {
      const sdkConfig = provider.buildSdkConfig(modelId);
      modelId = sdkConfig.envVars.ANTHROPIC_MODEL ?? modelId;
      baseUrl = (sdkConfig.envVars.ANTHROPIC_BASE_URL as string | undefined) || baseUrl;
      apiVersion = sdkConfig.apiVersion || apiVersion;
    } catch (err) {
      // provider not yet initialised (e.g. embedded server not started); use defaults
      // Log a warning so this is diagnosable: without it, a Copilot session whose
      // embedded server was not pre-warmed would silently call api.anthropic.com with
      // an empty auth token, producing an opaque 401 error during title generation.
      this.logger.warn(
        `[ProviderService] getTitleGenerationConfig: buildSdkConfig failed for provider` +
          ` '${providerId}' — falling back to Anthropic defaults. Cause: ${err}`
      );
    }

    return { modelId, baseUrl, apiVersion };
  }

  /**
   * Check if a model is valid for a provider
   */
  async isModelValidForProvider(providerId: Provider, model: string): Promise<boolean> {
    const registry = await this.getReadyRegistry();
    const provider = registry.get(providerId);

    if (!provider) {
      return false;
    }

    return provider.ownsModel(model);
  }

  /**
   * Get environment variables for SDK subprocess based on explicit (modelId, providerId) pair.
   *
   * Both the model ID and provider ID must be known at the call site. Use
   * `getProviderEnvVars(session)` when you have a full session object.
   *
   * @param modelId - The model ID (used for SDK config building)
   * @param providerId - The provider ID — must be explicit; routing is deterministic
   */
  async getEnvVarsForModel(modelId: string, providerId: string): Promise<ProviderEnvVars> {
    await this.getReadyRegistry();
    const registry = this.getRegistry();
    const provider = registry.detectProviderForModel(modelId, providerId);

    if (!provider) {
      return {};
    }

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
      // provider not yet initialised (e.g. embedded server not started)
      return {};
    }
  }

  /**
   * Get environment variables for SDK subprocess based on session's provider
   *
   * Delegates to provider.buildSdkConfig() with session config
   */
  getProviderEnvVars(session: Session): ProviderEnvVars {
    const registry = this.getRegistry();
    const providerId = session.config.provider || 'anthropic';
    const provider = registry.get(providerId);

    if (!provider) {
      return {};
    }

    // Build SDK config with session override.
    // workspacePath is always forwarded so embedded bridge providers can use
    // the correct cwd per request (encoded in ANTHROPIC_AUTH_TOKEN by some providers).
    const effectiveWorkspacePath = session.worktree?.worktreePath ?? session.workspacePath;
    const sessionConfig = {
      workspacePath: effectiveWorkspacePath ?? undefined,
      sessionId: session.id,
      ...(session.config.providerConfig
        ? {
            apiKey: session.config.providerConfig.apiKey,
            baseUrl: session.config.providerConfig.baseUrl,
            region: session.config.providerConfig.region,
          }
        : {}),
    };

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
      // provider not yet initialised (e.g. embedded server not started)
      return {};
    }
  }

  /**
   * Apply provider environment variables to process.env using the full session.
   *
   * Session-aware bridge providers (Codex, Copilot) encode the HyperNeo session ID
   * and effective workspace path into their SDK config. Using only (model, provider)
   * collapses all sessions to provider defaults such as `sessionId=default`.
   */
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

  /**
   * Apply provider environment variables to process.env.
   *
   * IMPORTANT: These must be set in the parent process before SDK query creation.
   * The SDK subprocess inherits these environment variables when spawned.
   *
   * This method saves the original values and returns them for restoration.
   *
   * @param modelId - The model ID (used for SDK config building)
   * @param providerId - The provider ID — must be explicit; routing is deterministic
   * @returns Original env vars that should be restored after SDK query
   */
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

  /**
   * Apply provider environment variables to process.env with explicit provider
   *
   * This variant takes an explicit provider parameter instead of detecting from model ID.
   * Use this when the model ID is a shorthand (like 'haiku') that doesn't identify the provider.
   *
   * @param providerId - The provider to get env vars for
   * @param modelId - The model ID for setting tier mappings
   * @returns Original env vars that should be restored after SDK query
   */
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
      sdkConfig = provider.buildSdkConfig(modelId || 'default', sessionConfig);
    } catch {
      // provider not yet initialised (e.g. embedded server not started); skip env-var injection
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

  /**
   * Internal helper to apply env vars and save originals
   */
  private applyEnvVars(
    envVars: ProviderEnvVars,
    options: { preserveApiKey?: boolean } = {}
  ): OriginalEnvVars {
    const original: OriginalEnvVars = {};

    // Save and set each env var
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
        // Empty string means "blank the key" — used by Anthropic-compatible
        // providers to prevent the SDK subprocess from falling back to a real
        // Anthropic API key while still satisfying integrations that require
        // ANTHROPIC_API_KEY to be explicitly empty.
        original.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = '';
      } else if (options.preserveApiKey) {
        original.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = envVars.ANTHROPIC_API_KEY;
      } else {
        // Non-empty: map API key value to ANTHROPIC_AUTH_TOKEN (legacy behaviour)
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
      // Empty string means "explicitly clear" so providers can prevent stale
      // auto-compact windows from leaking into the SDK subprocess.
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

    // Always clear PORT and HYPERNEO_PORT so SDK subprocesses cannot inherit the
    // daemon's listening port and trigger a kill-chain via `lsof -i :<port>`.
    this.saveClearDaemonPortEnvVars(original);

    return original;
  }

  /**
   * Clear provider routing overrides from process.env and return originals.
   *
   * These vars force Anthropic-compatible traffic to a non-default provider.
   * If they leak across queries, model selection can appear "stuck" (e.g., glm-5).
   */
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

    // Preserve user's custom ANTHROPIC_MODEL while clearing provider leaks.
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

    // Preserve user's Claude Code subagent/tool-search settings while clearing provider leaks.
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

    // Preserve user's custom ANTHROPIC_BASE_URL from environment/settings.json.
    // When the Dev Proxy test harness is active (HYPERNEO_USE_DEV_PROXY=1), the
    // localhost proxy URL is preserved so test mock routing survives provider-env
    // clearing. Production localhost bridges (Ollama, Copilot, custom endpoints)
    // are cleared normally on provider switches.
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

    // Preserve user's custom API_TIMEOUT_MS
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

    // Preserve user's custom CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
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

    // Preserve user's custom auto-compact window while clearing provider leaks.
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

    // Preserve user's custom ANTHROPIC_DEFAULT_SONNET_MODEL
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

    // Preserve user's custom ANTHROPIC_DEFAULT_HAIKU_MODEL
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

    // Preserve user's custom ANTHROPIC_DEFAULT_OPUS_MODEL
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

    // Always clear PORT, HYPERNEO_PORT, and stale NEOKAI_PORT so SDK subprocesses
    // cannot inherit the daemon's listening port and trigger a kill-chain via
    // `lsof -i :<port>`.
    this.saveClearDaemonPortEnvVars(original);
    changed =
      changed ||
      original.PORT !== undefined ||
      original.HYPERNEO_PORT !== undefined ||
      original.NEOKAI_PORT !== undefined;

    return changed ? original : {};
  }

  /**
   * Save and delete PORT, HYPERNEO_PORT, and stale NEOKAI_PORT from process.env.
   *
   * Called by every path that prepares env vars for an SDK subprocess so the
   * daemon's listening port is never visible to agent bash commands.
   */
  private saveClearDaemonPortEnvVars(original: OriginalEnvVars): void {
    original.PORT = process.env.PORT;
    delete process.env.PORT;
    original.HYPERNEO_PORT = process.env.HYPERNEO_PORT;
    delete process.env.HYPERNEO_PORT;
    original.NEOKAI_PORT = process.env.NEOKAI_PORT;
    delete process.env.NEOKAI_PORT;
  }

  /**
   * Restore original environment variables after SDK query completes
   *
   * @param original - The original env vars returned by applyEnvVarsToProcess
   */
  restoreEnvVars(original: OriginalEnvVars): void {
    if (Object.keys(original).length === 0) {
      return;
    }

    // Restore only keys captured in `original`.
    // This prevents unrelated vars from being cleared when a caller only changed a subset.
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

  /**
   * Check if GLM API key is available
   * Used to determine if GLM models should be shown in the model list
   */
  async isGlmAvailable(): Promise<boolean> {
    return this.isProviderAvailable('glm');
  }
}

/**
 * Merge provider environment variables with process.env
 *
 * This is used when spawning SDK subprocesses to ensure:
 * - Provider-specific vars (like ANTHROPIC_BASE_URL) override defaults
 * - Parent process vars (like ANTHROPIC_API_KEY) are inherited
 *
 * @param providerEnvVars - Provider-specific environment variables
 * @returns Merged environment variables for subprocess
 */
export function mergeProviderEnvVars(providerEnvVars: ProviderEnvVars): NodeJS.ProcessEnv {
  return { ...process.env, ...providerEnvVars };
}

// Singleton instance — stored on globalThis to survive ESM module duplication
// in Bun's test runner (different import paths can load the same module twice,
// each with its own module-level let, breaking singleton guarantees).
const PROVIDER_SERVICE_KEY = Symbol.for('hyperneo:providerServiceInstance');

/**
 * Detect whether the Dev Proxy test harness is active.
 *
 * Only when `HYPERNEO_USE_DEV_PROXY=1` is set do we treat a localhost
 * `ANTHROPIC_BASE_URL` as a Dev Proxy URL that must survive provider-env
 * clearing. Production bridge providers (Ollama, Copilot, custom endpoints)
 * also use localhost base URLs, so preserving them unconditionally would leak
 * stale bridge URLs into the next Anthropic turn.
 */
function isDevProxyActive(): boolean {
  return process.env.HYPERNEO_USE_DEV_PROXY === '1';
}

/**
 * Detect whether an Anthropic base URL points at the local Dev Proxy instance.
 * Gated on `HYPERNEO_USE_DEV_PROXY` so production localhost bridges are cleared
 * normally on provider switches.
 */
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

/**
 * User-configured env vars captured at module initialization.
 * These preserve values from environment/settings.json while allowing
 * provider-leaked values to be cleared.
 *
 * IMPORTANT: These must be captured AFTER credential discovery has run.
 * The import order in main.ts ensures config.ts (which calls discoverCredentials)
 * is imported before app.ts (which triggers provider-service.ts loading).
 */
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

/**
 * Snapshot of user-configured Anthropic env values captured at daemon startup.
 *
 * Excludes provider-leaked routing vars from concurrent bridge turns — those are
 * set/cleared dynamically by `applyEnvVarsToProcessForSession`, while the values
 * here are frozen at module load. Use this when a subprocess (e.g. an external
 * ACP agent) must inherit the user's real endpoint/model/auth overrides without
 * being contaminated by another provider's in-flight routing state.
 *
 * Auth tokens (ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN) are intentionally
 * read live from `process.env` at call time rather than snapshotted here, because
 * credential discovery runs after module load and may populate them later.
 */
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

/** Reset singleton — tests only */
export function resetProviderServiceInstance(): void {
  delete (globalThis as Record<symbol, unknown>)[PROVIDER_SERVICE_KEY];
}

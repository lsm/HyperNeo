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
 *    - ANTHROPIC_DEFAULT_*_MODEL (tier mappings)
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

import type { Provider, ProviderInfo, Session } from '@neokai/shared';
import type { ProviderSdkConfig, ProviderInfo as NewProviderInfo } from '@neokai/shared/provider';
import { initializeProviders } from './providers/factory.js';
import { Logger } from './logger.js';

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
	ANTHROPIC_DEFAULT_HAIKU_MODEL?: string; // Map haiku tier to provider model
	ANTHROPIC_DEFAULT_SONNET_MODEL?: string; // Map default/sonnet tier to provider model
	ANTHROPIC_DEFAULT_OPUS_MODEL?: string; // Map opus tier to provider model
	API_TIMEOUT_MS?: string;
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC?: string;
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
	API_TIMEOUT_MS?: string;
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC?: string;
	ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
	ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
	ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
	CLAUDE_CODE_OAUTH_TOKEN?: string;
	CLAUDE_AGENT_SDK_CLIENT_APP?: string;
	/** Daemon's listening PORT — cleared from subprocess env to prevent kill-chain via lsof */
	PORT?: string;
	/** Daemon's NEOKAI_PORT — also cleared to prevent subprocess env leakage */
	NEOKAI_PORT?: string;
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

	/**
	 * Get the default provider based on environment configuration
	 *
	 * Delegates to registry.getDefaultProvider()
	 */
	async getDefaultProvider(): Promise<Provider> {
		const registry = this.getRegistry();
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
		const registry = this.getRegistry();
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
		const registry = this.getRegistry();
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
		const registry = this.getRegistry();
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
		const registry = this.getRegistry();
		return await registry.validateProviderSwitch(providerId, apiKey);
	}

	/**
	 * Get the default model for a provider
	 */
	async getDefaultModelForProvider(providerId: Provider): Promise<string> {
		const registry = this.getRegistry();
		const provider = registry.get(providerId);

		if (!provider) {
			return 'default';
		}

		const models = await provider.getModels();
		return models[0]?.id || 'default';
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
		const registry = this.getRegistry();
		const provider = registry.get(providerId);

		if (!provider) {
			// Fallback to Anthropic
			return {
				modelId: 'haiku',
				baseUrl: 'https://api.anthropic.com',
				apiVersion: 'v1',
			};
		}

		const models = await provider.getModels();

		// Use haiku tier model for title generation (fast/cheap)
		const modelId = provider.getModelForTier('haiku') || models[0]?.id || 'default';

		// Get base URL from SDK config
		let baseUrl = 'https://api.anthropic.com';
		let apiVersion = 'v1';
		try {
			const sdkConfig = provider.buildSdkConfig(modelId);
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
		const registry = this.getRegistry();
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
	getEnvVarsForModel(modelId: string, providerId: string): ProviderEnvVars {
		const registry = this.getRegistry();
		const provider = registry.detectProviderForModel(modelId, providerId);

		if (!provider || provider.id === 'anthropic') {
			// When Dev Proxy is enabled, route Anthropic API calls through the proxy
			if (process.env.NEOKAI_USE_DEV_PROXY === '1') {
				return { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8000' };
			}
			return {};
		}

		try {
			const sdkConfig = provider.buildSdkConfig(modelId);
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

		if (!provider || providerId === 'anthropic') {
			// When Dev Proxy is enabled, route Anthropic API calls through the proxy
			if (process.env.NEOKAI_USE_DEV_PROXY === '1') {
				return { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8000' };
			}
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
					}
				: {}),
		};

		const modelId = session.config.model || 'default';
		try {
			const sdkConfig = provider.buildSdkConfig(modelId, sessionConfig);
			return sdkConfigToEnvVars(sdkConfig);
		} catch {
			// provider not yet initialised (e.g. embedded server not started)
			return {};
		}
	}

	/**
	 * Apply provider environment variables to process.env using the full session.
	 *
	 * Session-aware bridge providers (Codex, Copilot) encode the NeoKai session ID
	 * and effective workspace path into their SDK config. Using only (model, provider)
	 * collapses all sessions to provider defaults such as `sessionId=default`.
	 */
	applyEnvVarsToProcessForSession(session: Session): OriginalEnvVars {
		const envVars = this.getProviderEnvVars(session);

		if (Object.keys(envVars).length === 0) {
			return this.clearProviderRoutingEnvVars();
		}

		return this.applyEnvVars(envVars);
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
	applyEnvVarsToProcess(modelId: string, providerId: string): OriginalEnvVars {
		const envVars = this.getEnvVarsForModel(modelId, providerId);

		// For Anthropic (or any non-overriding provider), explicitly clear routing
		// overrides that may have leaked from a previous GLM query.
		if (Object.keys(envVars).length === 0) {
			return this.clearProviderRoutingEnvVars();
		}

		return this.applyEnvVars(envVars);
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
	applyEnvVarsToProcessForProvider(providerId: string, modelId?: string): OriginalEnvVars {
		const registry = this.getRegistry();
		const provider = registry.get(providerId);

		if (!provider) {
			return {};
		}
		if (providerId === 'anthropic') {
			return this.clearProviderRoutingEnvVars();
		}

		const sessionConfig = modelId ? { apiKey: undefined } : undefined;
		let sdkConfig;
		try {
			sdkConfig = provider.buildSdkConfig(modelId || 'default', sessionConfig);
		} catch {
			// provider not yet initialised (e.g. embedded server not started); skip env-var injection
			return {};
		}
		const envVars = sdkConfigToEnvVars(sdkConfig);

		return this.applyEnvVars(envVars);
	}

	/**
	 * Internal helper to apply env vars and save originals
	 */
	private applyEnvVars(envVars: ProviderEnvVars): OriginalEnvVars {
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

		// Always clear PORT and NEOKAI_PORT so SDK subprocesses cannot inherit the
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
	private clearProviderRoutingEnvVars(): OriginalEnvVars {
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

		// Preserve user's custom ANTHROPIC_BASE_URL from environment/settings.json
		if (process.env.ANTHROPIC_BASE_URL !== undefined) {
			original.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
			changed = true;
			if (
				userConfiguredBaseUrl === undefined ||
				process.env.ANTHROPIC_BASE_URL !== userConfiguredBaseUrl
			) {
				delete process.env.ANTHROPIC_BASE_URL;
			}
		}

		// Preserve user's custom API_TIMEOUT_MS
		if (process.env.API_TIMEOUT_MS !== undefined) {
			original.API_TIMEOUT_MS = process.env.API_TIMEOUT_MS;
			changed = true;
			if (
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
				userConfiguredDisableNonEssentialTraffic === undefined ||
				process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC !==
					userConfiguredDisableNonEssentialTraffic
			) {
				delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
			}
		}

		// Preserve user's custom ANTHROPIC_DEFAULT_SONNET_MODEL
		if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL !== undefined) {
			original.ANTHROPIC_DEFAULT_SONNET_MODEL = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
			changed = true;
			if (
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
				userConfiguredDefaultOpusModel === undefined ||
				process.env.ANTHROPIC_DEFAULT_OPUS_MODEL !== userConfiguredDefaultOpusModel
			) {
				delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
			}
		}

		// Always clear PORT and NEOKAI_PORT so SDK subprocesses cannot inherit the
		// daemon's listening port and trigger a kill-chain via `lsof -i :<port>`.
		this.saveClearDaemonPortEnvVars(original);
		changed = changed || original.PORT !== undefined || original.NEOKAI_PORT !== undefined;

		return changed ? original : {};
	}

	/**
	 * Save and delete PORT and NEOKAI_PORT from process.env.
	 *
	 * Called by every path that prepares env vars for an SDK subprocess so the
	 * daemon's listening port is never visible to agent bash commands.
	 */
	private saveClearDaemonPortEnvVars(original: OriginalEnvVars): void {
		original.PORT = process.env.PORT;
		delete process.env.PORT;
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
const PROVIDER_SERVICE_KEY = Symbol.for('neokai:providerServiceInstance');

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
const userConfiguredDefaultSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
const userConfiguredDefaultHaikuModel = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
const userConfiguredDefaultOpusModel = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;

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

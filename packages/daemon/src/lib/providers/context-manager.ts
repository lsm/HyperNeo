/**
 * Provider Context Manager
 *
 * Manages provider-specific contexts without global state mutation.
 * Creates isolated scopes for provider configuration per session.
 *
 * This replaces the environment variable mutation pattern with a
 * cleaner approach where provider configuration is built into
 * SDK options directly.
 */

import type { Provider, ProviderContext } from '@hyperneo/shared/provider';
import type { Session, ProviderId } from '@hyperneo/shared';
import type { ProviderRegistry } from './registry.js';

/**
 * Context implementation class
 */
class ContextImpl implements ProviderContext {
  readonly sessionConfig;

  constructor(
    readonly provider: Provider,
    readonly sdkConfig: ProviderContext['sdkConfig'],
    readonly modelId: string,
    sessionConfig?: Record<string, unknown>
  ) {
    this.sessionConfig = sessionConfig;
  }

  /**
   * Get the SDK-compatible model ID
   * Applies translation if provider needs it
   */
  getSdkModelId(): string {
    const providerModel = this.sdkConfig.envVars.ANTHROPIC_MODEL;
    if (providerModel) {
      return providerModel;
    }
    if (this.provider.translateModelIdForSdk) {
      return this.provider.translateModelIdForSdk(this.modelId);
    }
    return this.modelId;
  }

  /**
   * Build SDK options with provider configuration applied
   * Merges base options with provider-specific env vars and settings
   */
  async buildSdkOptions<T extends Record<string, unknown>>(baseOptions: T): Promise<T> {
    const sdkModelId = this.getSdkModelId();

    // Merge provider env vars with base options
    const mergedEnv: Record<string, string> = {
      ...(baseOptions.env as Record<string, string> | undefined),
      ...this.sdkConfig.envVars,
    };

    // Build merged options
    const mergedOptions: T = {
      ...baseOptions,
      model: sdkModelId,
      env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
    };

    // Merge any additional SDK options from provider
    if (this.sdkConfig.sdkOptions) {
      Object.assign(mergedOptions, this.sdkConfig.sdkOptions);
    }

    return mergedOptions;
  }
}

/**
 * Provider Context Manager
 *
 * Creates and manages provider contexts for sessions.
 */
export class ProviderContextManager {
  constructor(private readonly registry: ProviderRegistry) {}

  /**
   * Create a provider context for a session.
   *
   * Provider resolution order:
   * 1. Explicit `session.config.provider` — used for all sessions created after PR #466.
   * 2. Anthropic fallback — for legacy sessions that pre-date PR #466 and have no stored
   *    provider. This keeps existing DB sessions working on upgrade.
   *
   * Throws only when a provider ID IS stored but that ID is not registered (hard
   * misconfiguration that should not be silently swallowed).
   */
  createContext(session: Session): ProviderContext {
    // Resolve provider for this session
    const provider = this.resolveProvider(session);
    const modelId = session.config.model || 'default';

    // Build SDK configuration for this provider. Some bridge providers encode
    // session identity and cwd in their SDK config, so provider context creation
    // must pass the full session scope rather than only providerConfig.
    const providerConfig = session.config.providerConfig;
    const sessionConfig = {
      workspacePath: session.worktree?.worktreePath ?? session.workspacePath ?? undefined,
      sessionId: session.id,
      ...(providerConfig
        ? {
            apiKey: providerConfig.apiKey,
            baseUrl: providerConfig.baseUrl,
            region: providerConfig.region,
          }
        : {}),
    };
    const sdkConfig = provider.buildSdkConfig(modelId, sessionConfig);

    return new ContextImpl(provider, sdkConfig, modelId, sessionConfig);
  }

  /**
   * Resolve the provider for a session.
   *
   * - No stored provider ID → fall back to Anthropic (legacy session from before PR #466).
   * - Stored provider ID not registered → throw (explicit misconfiguration, not a migration gap).
   */
  private resolveProvider(session: Session): Provider {
    const providerId = session.config.provider;

    if (providerId) {
      const provider = this.registry.get(providerId);
      if (!provider) {
        throw new Error(
          `Provider '${providerId}' (requested by session '${session.id}') is not registered.`
        );
      }
      return provider;
    }

    // Legacy path: sessions created before PR #466 have no stored provider.
    // Fall back to Anthropic so existing DB sessions continue to work after upgrade.
    const anthropic = this.registry.get('anthropic');
    if (anthropic) {
      return anthropic;
    }

    throw new Error(
      `Session '${session.id}' has no provider stored and the Anthropic provider is not registered.`
    );
  }

  /**
   * Check if a model switch requires a query restart.
   *
   * Cross-provider switches require restart because the SDK subprocess
   * needs different environment variables.
   *
   * @param session - Current session (used to resolve the current provider)
   * @param newModelId - Target model ID (informational)
   * @param newProviderId - Target provider ID (explicit — must be known by the caller)
   */
  requiresQueryRestart(session: Session, newModelId: string, newProviderId: string): boolean {
    let currentProvider: Provider;
    try {
      currentProvider = this.resolveProvider(session);
    } catch {
      // Cannot resolve the current provider — assume the switch crosses providers.
      // This is the conservative/safe value: a restart that wasn't strictly needed
      // is far less harmful than skipping a restart that was required.
      return true;
    }

    const newProvider = this.registry.get(newProviderId);

    // If the new provider is unknown, assume a different one — safer to restart
    if (!newProvider) {
      return true;
    }

    return currentProvider.id !== newProvider.id;
  }

  /**
   * Get provider by ID
   */
  getProvider(providerId: ProviderId): Provider | undefined {
    return this.registry.get(providerId);
  }

  /**
   * Validate a provider switch
   */
  async validateProviderSwitch(
    providerId: ProviderId,
    apiKey?: string
  ): Promise<{ valid: boolean; error?: string }> {
    return this.registry.validateProviderSwitch(providerId, apiKey);
  }

  /**
   * Get available providers
   */
  async getAvailableProviders(): Promise<Provider[]> {
    return this.registry.getAvailable();
  }
}

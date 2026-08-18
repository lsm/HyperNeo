import type { Provider, ProviderContext } from '@hyperneo/shared/provider';
import type { Session, ProviderId } from '@hyperneo/shared';
import type { ProviderRegistry } from './registry.js';

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

  async buildSdkOptions<T extends Record<string, unknown>>(baseOptions: T): Promise<T> {
    const sdkModelId = this.getSdkModelId();

    const mergedEnv: Record<string, string> = {
      ...(baseOptions.env as Record<string, string> | undefined),
      ...this.sdkConfig.envVars,
    };

    const mergedOptions: T = {
      ...baseOptions,
      model: sdkModelId,
      env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
    };

    if (this.sdkConfig.sdkOptions) {
      Object.assign(mergedOptions, this.sdkConfig.sdkOptions);
    }

    return mergedOptions;
  }
}

export class ProviderContextManager {
  constructor(private readonly registry: ProviderRegistry) {}

  createContext(session: Session): ProviderContext {
    const provider = this.resolveProvider(session);
    const modelId = session.config.model || 'default';

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

    const anthropic = this.registry.get('anthropic');
    if (anthropic) {
      return anthropic;
    }

    throw new Error(
      `Session '${session.id}' has no provider stored and the Anthropic provider is not registered.`
    );
  }

  requiresQueryRestart(session: Session, newModelId: string, newProviderId: string): boolean {
    let currentProvider: Provider;
    try {
      currentProvider = this.resolveProvider(session);
    } catch {
      return true;
    }

    const newProvider = this.registry.get(newProviderId);

    if (!newProvider) {
      return true;
    }

    return currentProvider.id !== newProvider.id;
  }

  getProvider(providerId: ProviderId): Provider | undefined {
    return this.registry.get(providerId);
  }

  async validateProviderSwitch(
    providerId: ProviderId,
    apiKey?: string
  ): Promise<{ valid: boolean; error?: string }> {
    return this.registry.validateProviderSwitch(providerId, apiKey);
  }

  async getAvailableProviders(): Promise<Provider[]> {
    return this.registry.getAvailable();
  }
}

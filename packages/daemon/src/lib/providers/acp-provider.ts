/**
 * ACP Provider - Agent Client Protocol agent runtime
 *
 * This provider uses ACP-compliant agents (e.g. Devin, Claude Code, Codex CLI)
 * via JSON-RPC 2.0 over stdio instead of the Claude Agent SDK HTTP path.
 *
 * ACP bypasses the SDK entirely; buildSdkConfig returns empty env vars.
 * The actual runtime is handled by AcpQueryRunner (PR4).
 */

import type {
  Provider,
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderSdkConfig,
  ProviderSessionConfig,
  ModelTier,
} from '@neokai/shared/provider';
import type { ModelInfo } from '@neokai/shared';

/**
 * ACP provider implementation
 */
export class AcpProvider implements Provider {
  readonly id = 'acp';
  readonly displayName = 'ACP Agent';

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    extendedThinking: true,
    thinkingModes: 'granular',
    maxContextWindow: 200000,
    functionCalling: true,
    vision: false,
  };

  /**
   * Static default models for ACP agents.
   * In PR5 these will be dynamically discovered from ACP configOptions.
   */
  static readonly MODELS: ModelInfo[] = [
    {
      id: 'acp-default',
      name: 'ACP Default',
      alias: 'acp',
      family: 'acp',
      provider: 'acp',
      contextWindow: 200000,
      description: 'ACP-compatible agent default model',
      releaseDate: '2026-01-01',
      available: true,
    },
  ];

  /**
   * Cached models from ACP runtime configOptions.
   * Populated dynamically when an ACP client initializes (PR5).
   */
  private cachedModels: ModelInfo[] | null = null;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  /**
   * Check if ACP is available.
   * Requires NEOKAI_ACP_COMMAND env var to be set.
   */
  isAvailable(): boolean {
    return !!this.getAcpCommand();
  }

  /**
   * Get the ACP agent spawn command from environment.
   */
  getAcpCommand(): string | undefined {
    return this.env.NEOKAI_ACP_COMMAND;
  }

  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    const command = this.getAcpCommand();
    return {
      isAuthenticated: !!command,
      method: 'api_key',
      error: command ? undefined : 'Set NEOKAI_ACP_COMMAND to enable ACP agents.',
    };
  }

  /**
   * Get available models for ACP.
   * Returns cached models from configOptions if populated, otherwise static defaults.
   */
  async getModels(): Promise<ModelInfo[]> {
    if (this.cachedModels) {
      return this.cachedModels;
    }
    return this.isAvailable() ? AcpProvider.MODELS : [];
  }

  /**
   * Update cached models from ACP runtime configOptions.
   * Called by AcpClient when it receives config_options from the agent.
   */
  setCachedModels(models: ModelInfo[]): void {
    this.cachedModels = models;
  }

  /**
   * Clear cached models so the next getModels() call falls back to defaults.
   */
  clearModelCache(): void {
    this.cachedModels = null;
  }

  /**
   * Check if a model ID belongs to ACP.
   */
  ownsModel(modelId: string): boolean {
    return modelId === 'acp' || modelId.toLowerCase().startsWith('acp-');
  }

  /**
   * Get model for a specific tier.
   * ACP uses a single default model for all tiers.
   */
  getModelForTier(_tier: ModelTier): string | undefined {
    return 'acp-default';
  }

  /**
   * Build SDK configuration for ACP.
   *
   * ACP bypasses the Claude Agent SDK HTTP path entirely. The ACP runtime
   * (AcpQueryRunner) spawns the agent subprocess directly and communicates
   * via JSON-RPC over stdio. Returning empty env vars signals that no
   * SDK-side HTTP configuration is needed.
   */
  buildSdkConfig(_modelId: string, _sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    return {
      envVars: {},
      isAnthropicCompatible: false,
    };
  }

  /**
   * Translate ACP model ID to SDK-compatible ID.
   * ACP model IDs are not recognized by the SDK; always return 'default'.
   */
  translateModelIdForSdk(_modelId: string): string {
    return 'default';
  }

  /**
   * Get the title generation model for ACP.
   */
  getTitleGenerationModel(): string {
    return 'acp-default';
  }
}

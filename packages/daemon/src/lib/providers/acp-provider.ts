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
import type { AcpConfigOption, ModelInfo } from '@neokai/shared';

const DEFAULT_ACP_CONTEXT_WINDOW = 200000;
const ACP_CONTEXT_WINDOW_ENV_VAR = 'NEOKAI_ACP_CONTEXT_WINDOW';

function parseContextWindow(value: string | undefined): number {
  if (!value) return DEFAULT_ACP_CONTEXT_WINDOW;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ACP_CONTEXT_WINDOW;

  return Math.trunc(parsed);
}

/**
 * ACP provider implementation
 */
export class AcpProvider implements Provider {
  readonly id = 'acp';
  readonly displayName = 'ACP Agent';

  static readonly DEFAULT_CONTEXT_WINDOW = DEFAULT_ACP_CONTEXT_WINDOW;
  static readonly CONTEXT_WINDOW_ENV_VAR = ACP_CONTEXT_WINDOW_ENV_VAR;

  get capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      extendedThinking: true,
      thinkingModes: 'granular',
      maxContextWindow: this.getContextWindow(),
      functionCalling: true,
      vision: false,
    };
  }

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
      contextWindow: DEFAULT_ACP_CONTEXT_WINDOW,
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

  /**
   * Get the configured ACP context window.
   */
  getContextWindow(): number {
    return parseContextWindow(this.env[ACP_CONTEXT_WINDOW_ENV_VAR]);
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
    if (!this.isAvailable()) return [];

    const contextWindow = this.getContextWindow();
    return AcpProvider.MODELS.map((model) => ({
      ...model,
      contextWindow,
    }));
  }

  /**
   * Update cached models from ACP runtime configOptions.
   * Called by AcpClient when it receives config_options from the agent.
   */
  setCachedModels(models: ModelInfo[]): void {
    this.cachedModels = models;
  }

  setConfigOptions(configOptions: AcpConfigOption[]): void {
    const modelOption = configOptions.find((option) => option.category === 'model');
    if (!modelOption) return;

    this.cachedModels = flattenModelChoices(modelOption).map((choice) => ({
      id: choice.value,
      name: choice.name,
      alias: choice.value,
      family: 'acp',
      provider: 'acp',
      contextWindow: this.getContextWindow(),
      description: `ACP model ${choice.name}`,
      releaseDate: '2026-01-01',
      available: true,
    }));
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

function flattenModelChoices(option: AcpConfigOption): Array<{ name: string; value: string }> {
  return option.options.flatMap((entry) => ('options' in entry ? entry.options : [entry]));
}

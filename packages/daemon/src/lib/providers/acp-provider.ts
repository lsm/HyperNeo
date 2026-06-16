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
import { spawnSync } from 'node:child_process';

const DEFAULT_ACP_CONTEXT_WINDOW = 200000;
const ACP_CONTEXT_WINDOW_ENV_VAR = 'NEOKAI_ACP_CONTEXT_WINDOW';
const ACP_PROBE_TIMEOUT_MS = 5000;

/**
 * Default ACP command probe: spawn the binary with `--help` to verify it exists
 * in PATH and is executable. Any exit code (including non-zero from an unknown
 * flag) means the binary is reachable — ACP agents may not implement `--help`
 * specifically. ENOENT means missing/unreachable.
 */
function defaultAcpCommandProbe(command: string): void {
  const parts = command.trim().split(/\s+/);
  const binary = parts[0];
  const args = parts.slice(1);
  // Always append `--help` so we don't accidentally start a long-running agent.
  // The flag is informational: we only care that the binary spawns.
  const result = spawnSync(binary, [...args, '--help'], {
    timeout: ACP_PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const err = result.error as NodeJS.ErrnoException | undefined;
  if (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`ACP command '${binary}' not found in PATH`);
    }
    // spawnSync surfaces timeouts via `signal === 'SIGTERM'` on `result`,
    // not on `error` itself — `error` is set when the child couldn't spawn.
    // The `signal` field lives on `result.signal` for normal exits, but for
    // timeouts the child is killed and the timeout is surfaced via
    // `result.signal === 'SIGTERM'`.
    throw new Error(`ACP command '${binary}' probe failed: ${err.message}`);
  }
  if (result.signal === 'SIGTERM') {
    throw new Error(`ACP command '${binary}' probe timed out after ${ACP_PROBE_TIMEOUT_MS}ms`);
  }
  // Any exit code means the binary spawned. ACP agents that reject `--help`
  // will exit non-zero but the binary itself is reachable.
}

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
      preferContextWindowMetadata: false,
    },
  ];

  /**
   * Cached models from ACP runtime configOptions.
   * Populated dynamically when an ACP client initializes (PR5).
   */
  private cachedModels: ModelInfo[] | null = null;

  /**
   * Cached result of the last binary-reachability probe so repeated
   * `providers.test` calls don't re-spawn the agent binary.
   */
  private lastProbeAt = 0;
  private lastProbeKey: string | undefined;
  private static readonly PROBE_TTL_MS = 30_000;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly commandProbe: (command: string) => void = defaultAcpCommandProbe
  ) {}

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
   * Verify the configured ACP binary is reachable by spawning it with
   * `--help`. Cached per command for `PROBE_TTL_MS` so repeated health checks
   * don't re-spawn the agent binary.
   *
   * @throws {Error} when the binary is missing, the spawn times out, or the
   *   probe otherwise fails.
   */
  private verifyCommandAvailable(): void {
    const command = this.getAcpCommand();
    if (!command) {
      throw new Error('NEOKAI_ACP_COMMAND not set');
    }
    // Only cache successful probes — failures self-heal on retry.
    if (this.lastProbeKey === command && Date.now() - this.lastProbeAt < AcpProvider.PROBE_TTL_MS) {
      return;
    }
    this.commandProbe(command);
    this.lastProbeKey = command;
    this.lastProbeAt = Date.now();
  }

  /**
   * Get available models for ACP.
   * Returns cached models from configOptions if populated, otherwise static defaults.
   * Verifies the agent binary is reachable before returning the default list.
   */
  async getModels(): Promise<ModelInfo[]> {
    if (this.cachedModels) {
      return this.cachedModels;
    }
    if (!this.isAvailable()) return [];

    // For the default static list, verify the binary actually exists in PATH
    // so `providers.test` fails fast on a misconfigured NEOKAI_ACP_COMMAND
    // instead of reporting healthy. Models discovered from runtime
    // configOptions are returned without re-probing because they were
    // populated by a real ACP client that already proved reachability.
    this.verifyCommandAvailable();

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

  getCachedModels(): ModelInfo[] | null {
    return this.cachedModels;
  }

  setConfigOptions(configOptions: AcpConfigOption[]): void {
    const modelOption = configOptions.find((option) => option.category === 'model');
    if (!modelOption) {
      this.clearModelCache();
      return;
    }

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
      preferContextWindowMetadata: false,
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
    return (
      modelId === 'acp' ||
      modelId.toLowerCase().startsWith('acp-') ||
      this.cachedModels?.some((model) => model.id === modelId || model.alias === modelId) === true
    );
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

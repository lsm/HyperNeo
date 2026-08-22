import type {
  Provider,
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderSdkConfig,
  ProviderSessionConfig,
  ModelTier,
} from '@hyperneo/shared/provider';
import type { AcpConfigOption, ModelInfo } from '@hyperneo/shared';
import { buildAcpSafeEnv, getAcpCommandIdentity, parseAcpCommand } from '../acp/acp-command';
import { AcpClient } from '../acp/acp-client';

const DEFAULT_ACP_CONTEXT_WINDOW = 200000;
const ACP_CONTEXT_WINDOW_ENV_VAR = 'HYPERNEO_ACP_CONTEXT_WINDOW';
const ACP_PROBE_TIMEOUT_MS = 10_000;

export type AcpCommandProbe = (command: string, timeoutMs?: number) => Promise<void>;

export const defaultAcpCommandProbe: AcpCommandProbe = async (
  commandLine: string,
  timeoutMs: number = ACP_PROBE_TIMEOUT_MS
): Promise<void> => {
  const { command, args } = parseAcpCommand(commandLine);
  const client = new AcpClient({
    command,
    args,
    cwd: process.cwd(),
    env: buildAcpSafeEnv(),
    requestTimeoutMs: timeoutMs,
  });
  try {
    await client.initialize();
    await client.authenticate();
  } finally {
    client.close();
  }
};

function parseContextWindow(value: string | undefined): number {
  if (!value) return DEFAULT_ACP_CONTEXT_WINDOW;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ACP_CONTEXT_WINDOW;

  return Math.trunc(parsed);
}

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

  private cachedModels: ModelInfo[] | null = null;

  private lastProbeAt = 0;
  private lastProbeKey: string | undefined;
  private static readonly PROBE_TTL_MS = 30_000;

  private commandOverride: string | undefined;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly commandProbe: AcpCommandProbe = defaultAcpCommandProbe
  ) {}

  isAvailable(): boolean {
    return !!this.getAcpCommand();
  }

  getAcpCommand(): string | undefined {
    return this.commandOverride ?? this.env.HYPERNEO_ACP_COMMAND;
  }

  setAcpCommand(command: string | undefined): void {
    const nextCommand = command ?? this.env.HYPERNEO_ACP_COMMAND;
    const nextIdentity = nextCommand ? getAcpCommandIdentity(nextCommand) : undefined;
    let previousIdentity: string | undefined;
    try {
      previousIdentity = this.getCommandIdentity();
    } catch {
      previousIdentity = undefined;
    }
    this.commandOverride = command;
    this.lastProbeKey = undefined;
    this.lastProbeAt = 0;
    if (nextIdentity !== previousIdentity) {
      this.clearModelCache();
    }
  }

  private getCommandIdentity(): string | undefined {
    const command = this.getAcpCommand();
    return command ? getAcpCommandIdentity(command) : undefined;
  }

  getContextWindow(): number {
    return parseContextWindow(this.env[ACP_CONTEXT_WINDOW_ENV_VAR]);
  }

  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    const command = this.getAcpCommand();
    return {
      isAuthenticated: !!command,
      method: 'api_key',
      error: command ? undefined : 'Set HYPERNEO_ACP_COMMAND to enable ACP agents.',
    };
  }

  async verifyCommandAvailable(): Promise<void> {
    const command = this.getAcpCommand();
    if (!command) {
      throw new Error('HYPERNEO_ACP_COMMAND not set');
    }
    if (this.lastProbeKey === command && Date.now() - this.lastProbeAt < AcpProvider.PROBE_TTL_MS) {
      return;
    }
    await this.commandProbe(command, ACP_PROBE_TIMEOUT_MS);
    this.lastProbeKey = command;
    this.lastProbeAt = Date.now();
  }

  async getModels(): Promise<ModelInfo[]> {
    if (!this.isAvailable()) {
      this.clearModelCache();
      return [];
    }
    if (this.cachedModels) {
      return this.cachedModels;
    }

    await this.verifyCommandAvailable();

    const contextWindow = this.getContextWindow();
    return AcpProvider.MODELS.map((model) => ({
      ...model,
      contextWindow,
    }));
  }

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

  clearModelCache(): void {
    this.cachedModels = null;
  }

  ownsModel(modelId: string): boolean {
    return (
      modelId === 'acp' ||
      modelId.toLowerCase().startsWith('acp-') ||
      this.cachedModels?.some((model) => model.id === modelId || model.alias === modelId) === true
    );
  }

  getModelForTier(_tier: ModelTier): string | undefined {
    return 'acp-default';
  }

  buildSdkConfig(_modelId: string, _sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    return {
      envVars: {},
      isAnthropicCompatible: false,
    };
  }

  translateModelIdForSdk(_modelId: string): string {
    return 'default';
  }

  getTitleGenerationModel(): string {
    return 'acp-default';
  }
}

function flattenModelChoices(option: AcpConfigOption): Array<{ name: string; value: string }> {
  return option.options.flatMap((entry) => ('options' in entry ? entry.options : [entry]));
}

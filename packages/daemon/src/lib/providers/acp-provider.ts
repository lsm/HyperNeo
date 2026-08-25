import type {
  Provider,
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderSdkConfig,
  ProviderSessionConfig,
  ModelTier,
  CuratedModel,
} from '@hyperneo/shared/provider';
import type { AcpConfigOption, ModelInfo } from '@hyperneo/shared';
import { buildAcpSafeEnv, getAcpCommandIdentity, parseAcpCommand } from '../acp/acp-command.ts';
import { AcpClient } from '../acp/acp-client.ts';
import { applyRecordedFailureToAuthStatus } from './provider-failure-store.js';

const DEFAULT_ACP_CONTEXT_WINDOW = 200000;
const ACP_CONTEXT_WINDOW_ENV_VAR = 'HYPERNEO_ACP_CONTEXT_WINDOW';
const ACP_PROBE_TIMEOUT_MS = 10_000;

export type AcpCommandProbe = (command: string, timeoutMs?: number) => Promise<void>;

export type AcpConfiguredModel = CuratedModel;

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
    replaceEnv: true,
    requestTimeoutMs: timeoutMs,
  });
  try {
    await client.initialize();
  } finally {
    await client.close();
  }
};

function parseContextWindow(value: string | undefined): number {
  if (!value) return DEFAULT_ACP_CONTEXT_WINDOW;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ACP_CONTEXT_WINDOW;

  return Math.trunc(parsed);
}

export type AcpCredentialEnvBaseline = Readonly<{
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
}>;

const ACP_CREDENTIAL_ENV_BASELINE: AcpCredentialEnvBaseline = Object.freeze({
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
});

export function getAcpCredentialEnvBaseline(): AcpCredentialEnvBaseline {
  return ACP_CREDENTIAL_ENV_BASELINE;
}

export class AcpProvider implements Provider {
  readonly id = 'acp';
  readonly displayName = 'ACP Agent';

  readonly credentialEnvBaseline: AcpCredentialEnvBaseline = ACP_CREDENTIAL_ENV_BASELINE;

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
  private cachedModelsCommandIdentity: string | undefined;

  private lastProbeAt = 0;
  private lastProbeKey: string | undefined;
  private static readonly PROBE_TTL_MS = 30_000;

  private commandOverride: string | undefined;
  private curatedModels: AcpConfiguredModel[] | undefined;

  private readonly env: NodeJS.ProcessEnv;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly commandProbe: AcpCommandProbe = defaultAcpCommandProbe
  ) {
    this.env = Object.freeze({ ...env });
  }

  isAvailable(): boolean {
    return !!this.getAcpCommand();
  }

  getAcpCommand(): string | undefined {
    return this.commandOverride ?? this.env.HYPERNEO_ACP_COMMAND;
  }

  setAcpCommand(command: string | undefined): void {
    const nextCommand = command ?? this.env.HYPERNEO_ACP_COMMAND;
    let nextIdentity: string | undefined;
    try {
      nextIdentity = nextCommand ? getAcpCommandIdentity(nextCommand) : undefined;
    } catch (err) {
      if (command !== undefined) throw err;
      nextIdentity = undefined;
    }
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

  private tryGetCommandIdentity(): string | undefined {
    try {
      return this.getCommandIdentity();
    } catch {
      return undefined;
    }
  }

  setCuratedModels(models: AcpConfiguredModel[] | undefined): void {
    this.curatedModels = models;
    this.rebuildModelsFromCurated();
  }

  private rebuildModelsFromCurated(): void {
    const commandIdentity = this.tryGetCommandIdentity();
    if (commandIdentity && this.curatedModels !== undefined) {
      this.cachedModels = this.curatedModels.map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        alias: model.id,
        family: 'acp',
        provider: 'acp',
        contextWindow: this.getContextWindow(),
        description: `ACP model ${model.name ?? model.id}`,
        releaseDate: '2026-01-01',
        available: true,
        preferContextWindowMetadata: false,
      }));
      this.cachedModelsCommandIdentity = commandIdentity;
    } else {
      this.cachedModels = null;
      this.cachedModelsCommandIdentity = undefined;
    }
  }

  getContextWindow(): number {
    return parseContextWindow(this.env[ACP_CONTEXT_WINDOW_ENV_VAR]);
  }

  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    const command = this.getAcpCommand();
    return applyRecordedFailureToAuthStatus(this.id, {
      isAuthenticated: !!command,
      method: 'api_key',
      error: command ? undefined : 'Set HYPERNEO_ACP_COMMAND to enable ACP agents.',
    });
  }

  async verifyCommandAvailable(options: { force?: boolean } = {}): Promise<void> {
    const command = this.getAcpCommand();
    if (!command) {
      throw new Error('HYPERNEO_ACP_COMMAND not set');
    }
    if (
      !options.force &&
      this.lastProbeKey === command &&
      Date.now() - this.lastProbeAt < AcpProvider.PROBE_TTL_MS
    ) {
      return;
    }
    await this.commandProbe(command, ACP_PROBE_TIMEOUT_MS);
    this.lastProbeKey = command;
    this.lastProbeAt = Date.now();
  }

  async getModels(): Promise<ModelInfo[]> {
    const commandIdentity = this.getCommandIdentity();
    if (!commandIdentity) {
      this.clearModelCache();
      return [];
    }
    if (this.cachedModelsCommandIdentity !== commandIdentity) {
      this.rebuildModelsFromCurated();
    }

    await this.verifyCommandAvailable();

    if (this.cachedModels) {
      return this.cachedModels;
    }

    const contextWindow = this.getContextWindow();
    return AcpProvider.MODELS.map((model) => ({
      ...model,
      contextWindow,
    }));
  }

  setCachedModels(models: ModelInfo[]): void {
    this.cachedModels = models;
    this.cachedModelsCommandIdentity = this.getCommandIdentity();
  }

  getCachedModels(): ModelInfo[] | null {
    if (this.cachedModels) return this.cachedModels;
    if (!this.tryGetCommandIdentity()) return null;
    const contextWindow = this.getContextWindow();
    return AcpProvider.MODELS.map((model) => ({
      ...model,
      contextWindow,
    }));
  }

  hasCuratedModelList(): boolean {
    return this.curatedModels !== undefined;
  }

  setConfigOptions(configOptions: AcpConfigOption[]): void {
    if (this.curatedModels !== undefined) return;
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
    this.cachedModelsCommandIdentity = this.getCommandIdentity();
  }

  clearModelCache(): void {
    this.rebuildModelsFromCurated();
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

export function flattenModelChoices(
  option: AcpConfigOption
): Array<{ name: string; value: string }> {
  return option.options.flatMap((entry) => ('options' in entry ? entry.options : [entry]));
}

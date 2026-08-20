import type {
  Provider,
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderSdkConfig,
  ProviderSessionConfig,
  ModelTier,
} from '@hyperneo/shared/provider';
import type { AcpConfigOption, ModelInfo } from '@hyperneo/shared';
import { spawn } from 'node:child_process';
import { buildAcpSafeEnv, getAcpCommandIdentity, parseAcpCommand } from '../acp/acp-command';
import { type AcpProcessTree, getAcpProcessTreeOwner } from '../acp/acp-process-tree';

const DEFAULT_ACP_CONTEXT_WINDOW = 200000;
const ACP_CONTEXT_WINDOW_ENV_VAR = 'HYPERNEO_ACP_CONTEXT_WINDOW';
const ACP_PROBE_TIMEOUT_MS = 5000;
const ACP_PROBE_KILL_TIMEOUT_MS = 1000;

export type AcpCommandProbe = (
  command: string,
  timeoutMs?: number,
  processGroupProbe?: (pid: number) => boolean
) => Promise<void>;

const defaultProcessGroupProbe = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

export interface AcpConfiguredModel {
  id: string;
  name?: string;
}

export const defaultAcpCommandProbe: AcpCommandProbe = async (
  commandLine: string,
  timeoutMs: number = ACP_PROBE_TIMEOUT_MS,
  processGroupProbe: (pid: number) => boolean = defaultProcessGroupProbe
): Promise<void> => {
  const { command, args } = parseAcpCommand(commandLine);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let processGroupGone = false;
    let processTree: AcpProcessTree | undefined;
    const child = spawn(command, args, {
      env: buildAcpSafeEnv(),
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: process.platform !== 'win32',
    });
    const recordGroupGone = () => {
      if (processGroupGone) return;
      const pid = child.pid;
      if (pid == null || processGroupProbe(pid)) return;
      processGroupGone = true;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };
    const timer = setTimeout(() => {
      processTree?.terminate('SIGTERM');
      killTimer = setTimeout(() => {
        recordGroupGone();
        if (!processGroupGone) processTree?.terminate('SIGKILL');
      }, ACP_PROBE_KILL_TIMEOUT_MS);
      killTimer.unref();
      settle(() =>
        reject(new Error(`ACP command '${command}' probe timed out after ${timeoutMs}ms`))
      );
    }, timeoutMs);
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    child.on('spawn', async () => {
      try {
        const owner = await getAcpProcessTreeOwner();
        const ownedTree = owner(child);
        processTree = ownedTree;
        ownedTree.terminate('SIGTERM');
        killTimer = setTimeout(() => {
          recordGroupGone();
          if (!processGroupGone) ownedTree.terminate('SIGKILL');
        }, ACP_PROBE_KILL_TIMEOUT_MS);
        killTimer.unref();
        recordGroupGone();
        settle(resolve);
      } catch (error) {
        child.kill('SIGKILL');
        settle(() => reject(error));
      }
    });
    child.on('exit', recordGroupGone);
    child.on('close', recordGroupGone);
    child.on('error', (err: NodeJS.ErrnoException) => {
      settle(() => {
        if (err.code === 'ENOENT') {
          reject(new Error(`ACP command '${command}' not found in PATH`));
          return;
        }
        reject(new Error(`ACP command '${command}' probe failed: ${err.message}`));
      });
    });
  });
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
  private cachedModelsCommandIdentity: string | undefined;

  private lastProbeAt = 0;
  private lastProbeKey: string | undefined;
  private static readonly PROBE_TTL_MS = 30_000;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly commandProbe: AcpCommandProbe = defaultAcpCommandProbe
  ) {}

  isAvailable(): boolean {
    return !!this.getAcpCommand();
  }

  private commandOverride: string | undefined;
  private curatedModels: AcpConfiguredModel[] | undefined;

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
      this.rebuildModelsFromCurated();
    }
  }

  setAcpModels(models: AcpConfiguredModel[] | undefined): void {
    this.curatedModels = models;
    this.rebuildModelsFromCurated();
  }

  private getCommandIdentity(): string | undefined {
    const command = this.getAcpCommand();
    return command ? getAcpCommandIdentity(command) : undefined;
  }

  private rebuildModelsFromCurated(): void {
    const commandIdentity = this.getCommandIdentity();
    if (commandIdentity && this.curatedModels !== undefined) {
      this.cachedModels =
        this.curatedModels.length > 0
          ? this.curatedModels.map((model) => ({
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
            }))
          : AcpProvider.MODELS.map((model) => ({
              ...model,
              contextWindow: this.getContextWindow(),
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
    return this.cachedModels;
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

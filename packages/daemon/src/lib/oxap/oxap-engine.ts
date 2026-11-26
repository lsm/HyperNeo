import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { OPENCODE_DSH_OVERLAY } from '@hyperneo/shared/types/oxap-harnesses';
import superpipe, { type PipelineAPI } from 'superpipe';
import { OpencodeProvider } from '../providers/opencode-provider.ts';
import { type BinaryIdentity, type PreparedOxapBinary, prepareOxapBinary } from './oxap-binary.ts';
import { OxapHubClient, type OxapHubClientOptions } from './oxap-hub-client.ts';
import type { OxapHubConfig } from './oxap-hub-config.ts';
import { createOxapQueryHub, type OxapQueryHub } from './oxap-query.ts';

export interface OxapEngineOptions {
  binaryPath: string;
  identity: BinaryIdentity;
  stateDirectory: string;
  hub: OxapHubConfig;
}

type Slot = {
  key: string;
  failed: boolean;
  client?: OxapHubClient;
  binary?: Extract<PreparedOxapBinary, { ok: true }>;
  start: Promise<OxapHubClient>;
};

function validateIdentity(options: OxapEngineOptions): OxapEngineOptions {
  if (!options.identity.version.trim() || !/^[a-f0-9]{64}$/i.test(options.identity.sha256)) {
    throw new Error('invalid OAP binary identity');
  }
  if (!isAbsolute(options.stateDirectory)) throw new Error('OAP hub paths must be absolute');
  return options;
}

function hubLaunch(options: OxapEngineOptions) {
  return {
    config: { adapters: options.hub.adapters },
    args: [
      'serve',
      '--stdio',
      '--config',
      join(options.stateDirectory, 'oap-serve.json'),
      '--session-history',
      join(options.stateDirectory, 'session-history.jsonl'),
    ],
    environment: options.hub.environment,
  };
}

async function readSnapshotNames(options: OxapEngineOptions): Promise<string[]> {
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  return readdir(options.stateDirectory);
}

function staleSnapshotPaths(options: OxapEngineOptions, names: string[]): string[] {
  return names
    .filter((name) => name.startsWith('oap-verified-'))
    .map((name) => join(options.stateDirectory, name));
}

async function removeStaleSnapshots(
  options: OxapEngineOptions,
  paths: string[]
): Promise<OxapEngineOptions> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  return options;
}

function checkBinary(options: OxapEngineOptions): Promise<PreparedOxapBinary> {
  return prepareOxapBinary(options.binaryPath, options.identity, options.stateDirectory);
}

function ensureValidBinary(
  check: PreparedOxapBinary,
  config: ReturnType<typeof hubLaunch>
): {
  config: ReturnType<typeof hubLaunch>;
  binary: Extract<PreparedOxapBinary, { ok: true }>;
} {
  if (!check.ok) throw new Error(`OAP binary rejected: ${check.reason}`);
  return { config, binary: check };
}

const opencodeDshOverlay = JSON.stringify([
  {
    id: 'llm-pi-ai',
    config: {
      providers: {
        'opencode-go': {
          api: 'openai-completions',
          apiKeyEnv: 'OPENCODE_API_KEY',
          baseURL: OpencodeProvider.CHAT_BASE_URL,
          compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
        },
      },
    },
  },
]);

async function writeConfig(
  options: OxapEngineOptions,
  validated: ReturnType<typeof ensureValidBinary>
): Promise<{ launch: OxapHubClientOptions; binary: typeof validated.binary }> {
  const { config, binary } = validated;
  try {
    if (options.hub.adapters.opencode?.provider === 'opencode-go') {
      await writeFile(join(options.stateDirectory, OPENCODE_DSH_OVERLAY), opencodeDshOverlay, {
        mode: 0o600,
      });
    }
    await writeFile(join(options.stateDirectory, 'oap-serve.json'), JSON.stringify(config.config), {
      mode: 0o600,
    });
    return {
      binary,
      launch: {
        command: binary.path,
        args: config.args,
        cwd: options.stateDirectory,
        env: config.environment,
      },
    };
  } catch (error) {
    await binary.cleanup();
    throw error;
  }
}

const prepareHub = (superpipe({})('oap.engine.prepare') as PipelineAPI)
  .input('options')
  .pipe(validateIdentity, 'options', 'validOptions')
  .pipe(hubLaunch, 'validOptions', 'config')
  .pipe(readSnapshotNames, 'validOptions', 'snapshotNames')
  .pipe(staleSnapshotPaths, ['validOptions', 'snapshotNames'], 'stalePaths')
  .pipe(removeStaleSnapshots, ['validOptions', 'stalePaths'], 'cleanOptions')
  .pipe(checkBinary, 'cleanOptions', 'check')
  .pipe(ensureValidBinary, ['check', 'config'], 'validated')
  .pipe(writeConfig, ['validOptions', 'validated'], 'launch')
  .endAsync('launch') as (options: OxapEngineOptions) => ReturnType<typeof writeConfig>;

export class OxapEngine {
  private slot?: Slot;
  private closed = false;
  private closing?: Promise<void>;

  createQueryHub(
    client: OxapHubClient,
    model?: Parameters<typeof createOxapQueryHub>[1]
  ): OxapQueryHub {
    return createOxapQueryHub(client, model);
  }

  isCurrentHub(client: OxapHubClient): boolean {
    const slot = this.slot;
    return !this.closed && !!slot && !slot.failed && slot.client === client;
  }

  async getHub(read: () => Promise<OxapEngineOptions>): Promise<OxapHubClient> {
    if (this.closed) throw new Error('OAP engine is closed');
    const options = await read();
    if (this.closed) throw new Error('OAP engine is closed');
    const key = JSON.stringify(options);
    const previous = this.slot;
    if (previous && !previous.failed && previous.key === key) return previous.start;
    if (previous) previous.failed = true;

    const slot: Slot = { key, failed: false, start: Promise.resolve(undefined as never) };
    this.slot = slot;
    slot.start = this.start(slot, options, previous);
    return slot.start;
  }

  restart(): Promise<void> {
    const slot = this.slot;
    if (slot) slot.failed = true;
    return this.closeSlot(slot);
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing ??= this.closeSlot(this.slot);
    return this.closing;
  }

  private async start(
    slot: Slot,
    options: OxapEngineOptions,
    previous?: Slot
  ): Promise<OxapHubClient> {
    try {
      await this.closeSlot(previous);
      if (this.closed) throw new Error('OAP engine is closed');
      const { launch, binary } = await prepareHub(options);
      slot.binary = binary;
      if (this.closed) throw new Error('OAP engine is closed');
      const client = new OxapHubClient({
        ...launch,
        onFailure: () => {
          slot.failed = true;
        },
      });
      slot.client = client;
      await client.connect();
      if (this.closed) throw new Error('OAP engine is closed');
      return client;
    } catch (error) {
      slot.failed = true;
      await slot.client?.close();
      await slot.binary?.cleanup();
      throw error;
    }
  }

  private async closeSlot(slot?: Slot): Promise<void> {
    if (!slot) return;
    await slot.start.catch(() => undefined);
    await slot.client?.close();
    await slot.binary?.cleanup();
  }
}

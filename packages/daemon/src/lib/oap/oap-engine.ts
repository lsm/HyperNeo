import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { prepareOapBinary, type PreparedOapBinary, type BinaryIdentity } from './oap-binary.ts';
import { OapHubClient, type OapHubClientOptions } from './oap-hub-client.ts';
import type { OapHubConfig } from './oap-hub-config.ts';
import { createOapQueryHub, type OapQueryHub } from './oap-query.ts';

export interface OapEngineOptions {
  binaryPath: string;
  identity: BinaryIdentity;
  stateDirectory: string;
  hub: OapHubConfig;
}

type Slot = {
  key: string;
  failed: boolean;
  client?: OapHubClient;
  binary?: Extract<PreparedOapBinary, { ok: true }>;
  start: Promise<OapHubClient>;
};

function validateIdentity(options: OapEngineOptions): OapEngineOptions {
  if (!options.identity.version.trim() || !/^[a-f0-9]{64}$/i.test(options.identity.sha256)) {
    throw new Error('invalid OAP binary identity');
  }
  if (!isAbsolute(options.stateDirectory)) throw new Error('OAP hub paths must be absolute');
  return options;
}

function hubLaunch(options: OapEngineOptions) {
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

async function readSnapshotNames(options: OapEngineOptions): Promise<string[]> {
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  return readdir(options.stateDirectory);
}

function staleSnapshotPaths(options: OapEngineOptions, names: string[]): string[] {
  return names
    .filter((name) => name.startsWith('oap-verified-'))
    .map((name) => join(options.stateDirectory, name));
}

async function removeStaleSnapshots(
  options: OapEngineOptions,
  paths: string[]
): Promise<OapEngineOptions> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  return options;
}

function checkBinary(options: OapEngineOptions): Promise<PreparedOapBinary> {
  return prepareOapBinary(options.binaryPath, options.identity, options.stateDirectory);
}

function ensureValidBinary(
  check: PreparedOapBinary,
  config: ReturnType<typeof hubLaunch>
): {
  config: ReturnType<typeof hubLaunch>;
  binary: Extract<PreparedOapBinary, { ok: true }>;
} {
  if (!check.ok) throw new Error(`OAP binary rejected: ${check.reason}`);
  return { config, binary: check };
}

async function writeConfig(
  options: OapEngineOptions,
  validated: ReturnType<typeof ensureValidBinary>
): Promise<{ launch: OapHubClientOptions; binary: typeof validated.binary }> {
  const { config, binary } = validated;
  try {
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
  .endAsync('launch') as (options: OapEngineOptions) => ReturnType<typeof writeConfig>;

export class OapEngine {
  private slot?: Slot;
  private closed = false;
  private closing?: Promise<void>;

  createQueryHub(client: OapHubClient): OapQueryHub {
    return createOapQueryHub(client);
  }

  isCurrentHub(client: OapHubClient): boolean {
    const slot = this.slot;
    return !this.closed && !!slot && !slot.failed && slot.client === client;
  }

  async getHub(read: () => Promise<OapEngineOptions>): Promise<OapHubClient> {
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
    options: OapEngineOptions,
    previous?: Slot
  ): Promise<OapHubClient> {
    try {
      await this.closeSlot(previous);
      if (this.closed) throw new Error('OAP engine is closed');
      const { launch, binary } = await prepareHub(options);
      slot.binary = binary;
      if (this.closed) throw new Error('OAP engine is closed');
      const client = new OapHubClient({
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

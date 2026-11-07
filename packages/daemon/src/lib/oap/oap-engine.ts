import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { checkOapBinary, type BinaryCheck, type BinaryIdentity } from './oap-binary.ts';
import { OapHubClient, type OapHubClientOptions } from './oap-hub-client.ts';
import { buildOapHubConfig, type OapHubConfigInput } from './oap-hub-config.ts';

export interface OapEngineOptions extends OapHubConfigInput {
  binaryPath: string;
  identity: BinaryIdentity;
}

type Slot = {
  key: string;
  failed: boolean;
  client?: OapHubClient;
  start: Promise<OapHubClient>;
};

function configurationKey(options: OapEngineOptions): string {
  return JSON.stringify([
    options.binaryPath,
    options.identity.version,
    options.identity.sha256.toLowerCase(),
    options.stateDirectory,
    options.codexExecutable,
    options.codexHome,
  ]);
}

function validateIdentity(options: OapEngineOptions): OapEngineOptions {
  if (!options.identity.version.trim() || !/^[a-f0-9]{64}$/i.test(options.identity.sha256)) {
    throw new Error('invalid OAP binary identity');
  }
  return options;
}

function checkBinary(options: OapEngineOptions): Promise<BinaryCheck> {
  return checkOapBinary(options.binaryPath, options.identity);
}

function ensureValidBinary(
  check: BinaryCheck,
  config: ReturnType<typeof buildOapHubConfig>
): ReturnType<typeof buildOapHubConfig> {
  if (!check.ok) throw new Error(`OAP binary rejected: ${check.reason}`);
  return config;
}

async function writeConfig(
  options: OapEngineOptions,
  config: ReturnType<typeof buildOapHubConfig>
): Promise<OapHubClientOptions> {
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(options.stateDirectory, 'oap-serve.json'), JSON.stringify(config.config), {
    mode: 0o600,
  });
  return {
    command: options.binaryPath,
    args: config.args,
    cwd: options.stateDirectory,
    env: config.environment,
  };
}

const prepareHub = (superpipe({})('oap.engine.prepare') as PipelineAPI)
  .input('options')
  .pipe(validateIdentity, 'options', 'validOptions')
  .pipe(buildOapHubConfig, 'validOptions', 'config')
  .pipe(checkBinary, 'validOptions', 'check')
  .pipe(ensureValidBinary, ['check', 'config'], 'validated')
  .pipe(writeConfig, ['validOptions', 'validated'], 'launch')
  .endAsync('launch') as (options: OapEngineOptions) => Promise<OapHubClientOptions>;

export class OapEngine {
  private slot?: Slot;
  private closed = false;
  private closing?: Promise<void>;

  async getHub(options: OapEngineOptions): Promise<OapHubClient> {
    if (this.closed) throw new Error('OAP engine is closed');
    const input = { ...options, identity: { ...options.identity } };
    const key = configurationKey(input);
    const previous = this.slot;
    if (previous && !previous.failed) {
      if (previous.key !== key)
        throw new Error('OAP hub configuration differs from the running hub');
      return previous.start;
    }

    const slot: Slot = { key, failed: false, start: Promise.resolve(undefined as never) };
    this.slot = slot;
    slot.start = this.start(slot, input, previous);
    return slot.start;
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
      const launch = await prepareHub(options);
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
      throw error;
    }
  }

  private async closeSlot(slot?: Slot): Promise<void> {
    if (!slot) return;
    await slot.start.catch(() => undefined);
    await slot.client?.close();
  }
}

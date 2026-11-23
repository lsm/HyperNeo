import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { GlobalSettings, ProviderRecord } from '@hyperneo/shared';
import {
  isOxapHarness,
  OXAP_HARNESSES,
  oxapHarness,
  type OxapHarnessId,
} from '@hyperneo/shared/types/oxap-harnesses';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationDefinition } from '../operations/registry.ts';
import { withProviderLock } from '../rpc-handlers/provider-mutation-lock.ts';
import type { OxapEngine, OxapEngineOptions } from './oxap-engine.ts';
import { buildHubConfig, missingSetting, savedOxapAdapter } from './oxap-hub-config.ts';
import { releaseName, type OxapHubBinary } from './oxap-install.ts';

export interface OxapSettingsDeps {
  readonly settings: () => Pick<GlobalSettings, 'oxapHub'>;
  readonly writeHub: (hub: OxapHubBinary) => void;
  readonly records: () => ProviderRecord[];
  readonly writeProvider: (id: string, configJson: string) => Promise<void>;
  readonly key: (providerId: string) => Promise<string | undefined>;
  readonly install: (installed: OxapHubBinary | undefined) => Promise<OxapHubBinary>;
  readonly engine: Pick<OxapEngine, 'restart'>;
  readonly stateDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

type Records = readonly Pick<ProviderRecord, 'providerId' | 'configJson'>[];

async function readKeys(records: Records, deps: OxapSettingsDeps) {
  const keys: Record<string, string | undefined> = {};
  for (const record of records) {
    if (savedOxapAdapter(record)?.row.key)
      keys[record.providerId] = await deps.key(record.providerId);
  }
  return keys;
}

const HUB_NOT_INSTALLED = 'OXAP hub is not installed; choose an OXAP harness in Settings';

async function isExecutableFile(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function newSessionOxapRefusal(
  harness: OxapHarnessId,
  provider: string,
  record: Pick<ProviderRecord, 'configJson'> | null,
  installed: OxapHubBinary | undefined,
  readKey: OxapSettingsDeps['key'] | undefined
): Promise<string | undefined> {
  const row = oxapHarness(harness);
  if (!row.providers.includes(provider)) return `${provider} cannot run on ${harness}`;
  if (!installed || !(await isExecutableFile(installed.path))) return HUB_NOT_INSTALLED;
  const saved = record && savedOxapAdapter({ providerId: provider, configJson: record.configJson });
  if (saved?.harness !== harness) return `${provider} needs an absolute executable path`;
  const executable = saved.settings.executable;
  if (executable && !(await isExecutableFile(executable)))
    return `${provider} needs an executable file; check Settings → Providers`;
  if (row.key && !(await readKey?.(provider))?.trim()) return `${provider} needs ${row.key}`;
  return undefined;
}

async function currentBinary(deps: OxapSettingsDeps): Promise<OxapHubBinary> {
  const installed = deps.settings().oxapHub;
  if (!installed) throw new Error(HUB_NOT_INSTALLED);
  if (installed.version === releaseName()) return installed;
  const updated = await deps.install(installed);
  deps.writeHub(updated);
  return updated;
}

function hubOptions(
  deps: OxapSettingsDeps,
  records: Records,
  keys: Record<string, string | undefined>,
  binary: OxapHubBinary
): OxapEngineOptions {
  const hub = buildHubConfig(records, OXAP_HARNESSES, deps.environment, keys);
  if ('reason' in hub) throw new Error(hub.reason);
  return {
    binaryPath: binary.path,
    identity: { version: binary.version, sha256: binary.sha256 },
    stateDirectory: deps.stateDirectory,
    hub: hub.value,
  };
}

export const readHubOptions = (superpipe({})('oxap.hub.inputs') as PipelineAPI)
  .input('deps')
  .pipe((deps: OxapSettingsDeps) => deps.records(), 'deps', 'records')
  .pipe(readKeys, ['records', 'deps'], 'keys')
  .pipe(currentBinary, 'deps', 'binary')
  .pipe(hubOptions, ['deps', 'records', 'keys', 'binary'], 'options')
  .endAsync('options') as (deps: OxapSettingsDeps) => Promise<OxapEngineOptions>;

const SaveInput = z.object({
  providerId: z.string().min(1),
  harness: z.string().min(1),
  settings: z.record(z.string(), z.string()).default({}),
});
type Save = z.infer<typeof SaveInput>;

function readBinary(input: Save, deps: OxapSettingsDeps) {
  const installed = deps.settings().oxapHub;
  return input.harness === 'sdk' ? installed : deps.install(installed);
}

type Plan = { id: string; configJson: string; next: Records };

function planSave(input: Save, records: ProviderRecord[]) {
  const record = records.find((entry) => entry.providerId === input.providerId);
  if (!record) return { reason: `Unknown provider ${input.providerId}` };
  const row = isOxapHarness(input.harness) ? oxapHarness(input.harness) : undefined;
  if (input.harness !== 'sdk' && !row?.providers.includes(record.providerId))
    return { reason: `${record.providerId} cannot run on ${input.harness}` };
  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(record.configJson ?? '{}') as Record<string, unknown>;
  } catch {
    return { reason: `${record.providerId} has an unreadable config` };
  }
  const { harness: _harness, ...rest } = stored;
  const settings = input.settings ?? {};
  const saved = !row && Object.keys(settings).length > 0 ? savedOxapAdapter(record) : undefined;
  const settingsRow = row ?? saved?.row;
  if (settingsRow) {
    const updated = { ...saved?.settings, ...settings };
    const missing = missingSetting(settingsRow, updated);
    if (missing) return { reason: `${record.providerId} needs an absolute ${missing} path` };
    rest.harnessSettings = updated;
  }
  if (row) rest.harness = input.harness;
  const configJson = JSON.stringify(rest);
  const next = records.map((entry) => (entry === record ? { ...entry, configJson } : entry));
  return { value: { id: record.id, configJson, next } };
}

function checkHub(plan: Plan, keys: Record<string, string | undefined>) {
  const hub = buildHubConfig(plan.next, OXAP_HARNESSES, {}, keys);
  return 'reason' in hub ? hub : { value: plan };
}

async function writeSave(deps: OxapSettingsDeps, binary: OxapHubBinary | undefined, plan: Plan) {
  await deps.writeProvider(plan.id, plan.configJson);
  if (binary) deps.writeHub(binary);
  return true;
}

type SaveResult = { accepted: true } | string;

const commitSave = (superpipe({})('oxap.settings.commit') as PipelineAPI)
  .input(['input', 'deps', 'binary'])
  .pipe((deps: OxapSettingsDeps) => deps.records(), 'deps', 'records')
  .pipe(planSave, ['input', 'records'], 'result:plan')
  .pipe((plan: Plan, deps: OxapSettingsDeps) => readKeys(plan.next, deps), ['plan', 'deps'], 'keys')
  .pipe(checkHub, ['plan', 'keys'], 'result:plan')
  .pipe(writeSave, ['deps', 'binary', 'plan'], 'saved')
  .pipe((deps: OxapSettingsDeps, _saved: true) => deps.engine.restart(), ['deps', 'saved'], 'done')
  .pipe(() => ({ accepted: true as const }), undefined, 'plan')
  .endAsync('plan') as (
  input: Save,
  deps: OxapSettingsDeps,
  binary: OxapHubBinary | undefined
) => Promise<SaveResult>;

const saveSettings = (superpipe({})('oxap.settings.save') as PipelineAPI)
  .input(['input', 'deps'])
  .pipe((deps: OxapSettingsDeps) => deps.records(), 'deps', 'records')
  .pipe(planSave, ['input', 'records'], 'result:plan')
  .pipe((plan: Plan, deps: OxapSettingsDeps) => readKeys(plan.next, deps), ['plan', 'deps'], 'keys')
  .pipe(checkHub, ['plan', 'keys'], 'result:plan')
  .pipe(readBinary, ['input', 'deps'], 'binary')
  .pipe(
    (input: Save, deps: OxapSettingsDeps, binary: OxapHubBinary | undefined) =>
      withProviderLock(() => commitSave(input, deps, binary)),
    ['input', 'deps', 'binary'],
    'plan'
  )
  .endAsync('plan') as (input: Save, deps: OxapSettingsDeps) => Promise<SaveResult>;

export function createOxapSettingsOperations(deps: OxapSettingsDeps): OperationDefinition[] {
  return [
    defineOperation({
      name: 'oxap.settings.save',
      description:
        "Choose a provider's harness: sdk for Claude Code, or an OXAP harness id with the settings it needs. Choosing an OXAP harness installs the pinned OXAP hub, checked against its release's SHA256SUMS.txt. Saving restarts the hub; runs in flight end as if it were lost.",
      inputSchema: SaveInput,
      resultSchema: z.union([
        z.object({ accepted: z.literal(true) }),
        z.object({ accepted: z.literal(false), reason: z.string() }),
      ]),
      policy: { safetyClass: 'human_only', caller: 'local_user' },
      execute: async (input) => {
        const result = await saveSettings(input, deps);
        return typeof result === 'string' ? { accepted: false as const, reason: result } : result;
      },
    }),
  ];
}

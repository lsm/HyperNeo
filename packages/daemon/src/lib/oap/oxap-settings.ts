import type { GlobalSettings, ProviderRecord } from '@hyperneo/shared';
import { isOxapHarness, OXAP_HARNESSES, oxapHarness } from '@hyperneo/shared/types/oxap-harnesses';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationDefinition } from '../operations/registry.ts';
import type { OapEngine, OapEngineOptions } from './oap-engine.ts';
import { buildHubConfig, harnessOf } from './oap-hub-config.ts';
import type { OxapHubBinary } from './oxap-install.ts';

export interface OxapSettingsDeps {
  readonly settings: () => Pick<GlobalSettings, 'oxapHub'>;
  readonly writeHub: (hub: OxapHubBinary) => void;
  readonly records: () => ProviderRecord[];
  readonly writeProvider: (id: string, configJson: string) => Promise<void>;
  readonly key: (providerId: string) => Promise<string | undefined>;
  readonly install: (installed: OxapHubBinary | undefined) => Promise<OxapHubBinary>;
  readonly engine: Pick<OapEngine, 'restart'>;
  readonly stateDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

type Records = readonly Pick<ProviderRecord, 'providerId' | 'configJson'>[];

async function readKeys(records: Records, deps: OxapSettingsDeps) {
  const keys: Record<string, string | undefined> = {};
  for (const record of records) {
    const harness = harnessOf(record);
    if (harness !== 'sdk' && oxapHarness(harness).key)
      keys[record.providerId] = await deps.key(record.providerId);
  }
  return keys;
}

function hubOptions(
  deps: OxapSettingsDeps,
  records: Records,
  keys: Record<string, string | undefined>
): OapEngineOptions {
  const binary = deps.settings().oxapHub;
  if (!binary) throw new Error('OXAP hub is not installed; choose an OXAP harness in Settings');
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
  .pipe(hubOptions, ['deps', 'records', 'keys'], 'options')
  .endAsync('options') as (deps: OxapSettingsDeps) => Promise<OapEngineOptions>;

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
  if (
    input.harness !== 'sdk' &&
    !(
      isOxapHarness(input.harness) &&
      oxapHarness(input.harness).providers.includes(record.providerId)
    )
  )
    return { reason: `${record.providerId} cannot run on ${input.harness}` };
  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(record.configJson ?? '{}') as Record<string, unknown>;
  } catch {
    return { reason: `${record.providerId} has an unreadable config` };
  }
  const { harness: _harness, harnessSettings: _settings, ...rest } = stored;
  const configJson = JSON.stringify(
    input.harness === 'sdk'
      ? rest
      : { ...rest, harness: input.harness, harnessSettings: input.settings }
  );
  const next = records.map((entry) => (entry === record ? { ...entry, configJson } : entry));
  return { value: { id: record.id, configJson, next } };
}

function checkHub(plan: Plan, keys: Record<string, string | undefined>) {
  const hub = buildHubConfig(plan.next, OXAP_HARNESSES, {}, keys);
  return 'reason' in hub ? hub : { value: plan };
}

async function writeSave(deps: OxapSettingsDeps, binary: OxapHubBinary | undefined, plan: Plan) {
  if (binary) deps.writeHub(binary);
  await deps.writeProvider(plan.id, plan.configJson);
  return true;
}

const saveSettings = (superpipe({})('oxap.settings.save') as PipelineAPI)
  .input(['input', 'deps'])
  .pipe(readBinary, ['input', 'deps'], 'binary')
  .pipe((deps: OxapSettingsDeps) => deps.records(), 'deps', 'records')
  .pipe(planSave, ['input', 'records'], 'result:plan')
  .pipe((plan: Plan, deps: OxapSettingsDeps) => readKeys(plan.next, deps), ['plan', 'deps'], 'keys')
  .pipe(checkHub, ['plan', 'keys'], 'result:plan')
  .pipe(writeSave, ['deps', 'binary', 'plan'], 'saved')
  .pipe((deps: OxapSettingsDeps, _saved: true) => deps.engine.restart(), ['deps', 'saved'], 'done')
  .pipe(() => ({ accepted: true as const }), undefined, 'plan')
  .endAsync('plan') as (
  input: Save,
  deps: OxapSettingsDeps
) => Promise<{ accepted: true } | string>;

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

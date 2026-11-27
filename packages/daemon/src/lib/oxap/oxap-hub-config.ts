import { isAbsolute, join } from 'node:path';
import type { ProviderRecord } from '@hyperneo/shared';
import {
  OXAP_HARNESSES,
  oxapModelProvider,
  type OxapHarness,
} from '@hyperneo/shared/types/oxap-harnesses';

export interface OxapHubConfig {
  adapters: Record<string, Record<string, unknown>>;
  environment: Record<string, string>;
}

type Records = readonly Pick<ProviderRecord, 'providerId' | 'configJson'>[];

type ProviderConfig = Pick<ProviderRecord, 'providerId' | 'configJson'>;

export function deepSeekModelProviderRefusal(
  modelProvider: string | undefined
): string | undefined {
  if (modelProvider && modelProvider !== 'opencode-go' && modelProvider !== 'opencode-zen')
    return 'DeepSeek model provider must be opencode-go or opencode-zen';
}

export function savedOxapAdapter(
  record: ProviderConfig,
  harnesses: Readonly<Record<string, OxapHarness>> = OXAP_HARNESSES
) {
  let settings: Record<string, string> | undefined;
  try {
    const config = JSON.parse(record.configJson ?? '{}') as { harnessSettings?: unknown } | null;
    const value = config?.harnessSettings;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      settings = value as Record<string, string>;
    }
  } catch {
    return undefined;
  }
  if (!settings) return undefined;
  const entry = Object.entries(harnesses).find(([, row]) =>
    row.providers.includes(record.providerId)
  );
  if (!entry || missingSetting(entry[1], settings)) return undefined;
  const [harness, row] = entry;
  const modelProvider = harness === 'oxap-deepseek' ? oxapModelProvider(settings) : undefined;
  return { harness, row, settings, modelProvider };
}

export function missingSetting(
  row: OxapHarness,
  settings: Readonly<Record<string, string>>
): string | undefined {
  return row.settings.find((name) => {
    const value = settings[name];
    return typeof value !== 'string' || !isAbsolute(value);
  });
}

export function buildHubConfig(
  records: Records,
  harnesses: Readonly<Record<string, OxapHarness>>,
  environment: Readonly<Record<string, string | undefined>>,
  keys: Readonly<Record<string, string | undefined>>,
  stateDirectory: string
): { value: OxapHubConfig } | { reason: string } {
  const config: OxapHubConfig = { adapters: {}, environment: {} };
  const owners: Record<string, string> = {};
  for (const record of records) {
    const saved = savedOxapAdapter(record, harnesses);
    if (!saved || deepSeekModelProviderRefusal(saved.modelProvider)) continue;
    const { row, settings, modelProvider } = saved;
    const keyName = modelProvider ? 'OPENCODE_API_KEY' : row.key;
    const key = modelProvider ? environment.OPENCODE_API_KEY : keys[record.providerId];
    if (modelProvider && !key?.trim()) continue;
    const names: string[] = [];
    for (const name of row.environment) {
      const value =
        name === 'DSH_HOME' && modelProvider ? join(stateDirectory, 'dsh') : environment[name];
      if (value === undefined) continue;
      config.environment[name] = value;
      names.push(name);
    }
    if (keyName && key !== undefined) {
      const owner = owners[keyName];
      if (owner && config.environment[keyName] !== key)
        return {
          reason: `${owner} and ${record.providerId} both set ${keyName} to different keys`,
        };
      owners[keyName] = record.providerId;
      config.environment[keyName] = key;
      if (!modelProvider) names.push(keyName);
    }
    config.adapters[record.providerId] = row.entry(settings, names, stateDirectory);
  }
  return { value: config };
}

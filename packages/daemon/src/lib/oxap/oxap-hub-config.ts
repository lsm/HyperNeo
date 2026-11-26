import { isAbsolute } from 'node:path';
import type { ProviderRecord } from '@hyperneo/shared';
import { OXAP_HARNESSES, type OxapHarness } from '@hyperneo/shared/types/oxap-harnesses';

export interface OxapHubConfig {
  adapters: Record<string, Record<string, unknown>>;
  environment: Record<string, string>;
}

type Records = readonly Pick<ProviderRecord, 'providerId' | 'configJson'>[];

type ProviderConfig = Pick<ProviderRecord, 'providerId' | 'configJson'>;

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
  return { harness, row, settings };
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
    if (!saved) continue;
    const { row, settings } = saved;
    const names = row.environment.filter((name) => environment[name] !== undefined);
    for (const name of names) config.environment[name] = environment[name]!;
    if (row.key && keys[record.providerId] !== undefined) {
      const owner = owners[row.key];
      if (owner && config.environment[row.key] !== keys[record.providerId])
        return {
          reason: `${owner} and ${record.providerId} both set ${row.key} to different keys`,
        };
      owners[row.key] = record.providerId;
      config.environment[row.key] = keys[record.providerId]!;
      names.push(row.key);
    }
    config.adapters[record.providerId] = row.entry(settings, names, stateDirectory);
  }
  return { value: config };
}

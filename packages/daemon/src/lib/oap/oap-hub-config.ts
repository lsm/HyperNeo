import { isAbsolute } from 'node:path';
import type { ProviderRecord } from '@hyperneo/shared';
import type { OxapHarness } from '@hyperneo/shared/types/oxap-harnesses';
import { engineForProvider } from '../agent/session-engine.ts';

export interface OapHubConfig {
  adapters: Record<string, Record<string, unknown>>;
  environment: Record<string, string>;
}

type Records = readonly Pick<ProviderRecord, 'providerId' | 'configJson'>[];

export function harnessOf(record: Pick<ProviderRecord, 'providerId' | 'configJson'>) {
  try {
    return engineForProvider(record.providerId, () => record);
  } catch {
    return 'sdk';
  }
}

export function harnessSettings(
  record: Pick<ProviderRecord, 'configJson'>
): Record<string, string> {
  const value = (JSON.parse(record.configJson ?? '{}') as { harnessSettings?: unknown })
    .harnessSettings;
  return value && typeof value === 'object' ? (value as Record<string, string>) : {};
}

export function missingSetting(
  row: OxapHarness,
  settings: Readonly<Record<string, string>>
): string | undefined {
  return row.settings.find((name) => !isAbsolute(settings[name] ?? ''));
}

export function buildHubConfig(
  records: Records,
  harnesses: Readonly<Record<string, OxapHarness>>,
  environment: Readonly<Record<string, string | undefined>>,
  keys: Readonly<Record<string, string | undefined>>
): { value: OapHubConfig } | { reason: string } {
  const config: OapHubConfig = { adapters: {}, environment: {} };
  const owners: Record<string, string> = {};
  for (const record of records) {
    const harness = harnessOf(record);
    if (harness === 'sdk') continue;
    const row = harnesses[harness];
    const settings = harnessSettings(record);
    const missing = missingSetting(row, settings);
    if (missing) continue;
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
    config.adapters[record.providerId] = row.entry(settings, names);
  }
  return { value: config };
}

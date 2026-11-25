import type * as Harnesses from '@hyperneo/shared/types/oxap-harnesses';

export async function withSyntheticOxapRow(importOriginal: () => Promise<typeof Harnesses>) {
  const real = await importOriginal();
  const OXAP_HARNESSES = {
    'oxap-codex': {
      ...real.OXAP_HARNESSES['oxap-codex'],
      providers: ['anthropic-codex', 'synthetic-codex'],
    },
    'oxap-synthetic': {
      label: 'OXAP Synthetic',
      adapter: 'memory',
      providers: ['synthetic-memory', 'synthetic-memory-2'],
      thinking: true,
      settings: [],
      environment: [],
      key: 'SYNTHETIC_API_KEY',
      entry: (_settings: Readonly<Record<string, string>>, environment: readonly string[]) => ({
        type: 'memory',
        environment,
      }),
      nativeId: (link: string) => /^memory:\/\/sessions\/([a-z0-9-]+)$/.exec(link)?.[1],
    },
  };
  return {
    ...real,
    OXAP_HARNESSES,
    isOxapHarness: (harness: unknown) =>
      typeof harness === 'string' && Object.hasOwn(OXAP_HARNESSES, harness),
    oxapHarness: (harness: keyof typeof OXAP_HARNESSES) => OXAP_HARNESSES[harness],
  };
}

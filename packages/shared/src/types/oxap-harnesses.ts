export type OxapHarness = {
  label: string;
  adapter: string;
  providers: readonly string[];
  thinking: boolean;
  nativeId: (link: string) => string | undefined;
};

export const OXAP_HARNESSES = {
  'oxap-codex': {
    label: 'OXAP Codex',
    adapter: 'codex',
    providers: ['anthropic-codex'],
    thinking: false,
    nativeId: (link: string) => /^codex:\/\/threads\/([a-zA-Z0-9._~-]+)$/.exec(link)?.[1],
  },
} as const satisfies Record<string, OxapHarness>;

export type OxapHarnessId = keyof typeof OXAP_HARNESSES;

export function isOxapHarness(harness: unknown): harness is OxapHarnessId {
  return typeof harness === 'string' && Object.hasOwn(OXAP_HARNESSES, harness);
}

export function oxapHarness(harness: OxapHarnessId): OxapHarness {
  return OXAP_HARNESSES[harness];
}

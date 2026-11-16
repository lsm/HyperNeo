export const OXAP_HARNESSES = {
  'oxap-codex': { label: 'OXAP Codex', adapter: 'codex', providers: ['anthropic-codex'] },
} as const;

export type OxapHarnessId = keyof typeof OXAP_HARNESSES;

export function isOxapHarness(harness: unknown): harness is OxapHarnessId {
  return typeof harness === 'string' && Object.hasOwn(OXAP_HARNESSES, harness);
}

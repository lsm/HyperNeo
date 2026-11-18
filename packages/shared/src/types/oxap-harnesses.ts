export type OxapHarness = {
  label: string;
  adapter: string;
  providers: readonly string[];
  thinking: boolean;
  settings: readonly string[];
  environment: readonly string[];
  key?: string;
  entry: (
    settings: Readonly<Record<string, string>>,
    environment: readonly string[]
  ) => Record<string, unknown>;
  nativeId: (link: string) => string | undefined;
};

export const OXAP_HARNESSES = {
  'oxap-codex': {
    label: 'OXAP Codex',
    adapter: 'codex',
    providers: ['anthropic-codex'],
    thinking: false,
    settings: ['executable'],
    environment: ['HOME', 'CODEX_HOME'],
    entry: (settings: Readonly<Record<string, string>>, environment: readonly string[]) => ({
      type: 'codex',
      executable: settings.executable,
      environment,
      any_directory: true,
      approval_policy: 'on-request',
      sandbox: 'workspace-write',
    }),
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

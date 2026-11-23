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

const DEEPSEEK_SESSION_PREFIX = 'deepseek://sessions/';

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
  'oxap-deepseek': {
    label: 'OXAP DeepSeek',
    adapter: 'deepseek',
    providers: ['deepseek'],
    thinking: false,
    settings: ['executable'],
    environment: ['HOME', 'PATH', 'DSH_HOME'],
    key: 'DEEPSEEK_API_KEY',
    entry: (settings: Readonly<Record<string, string>>, environment: readonly string[]) => ({
      type: 'deepseek',
      executable: settings.executable,
      args: ['--profile', 'sdk'],
      environment,
      any_directory: true,
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    }),
    nativeId: (link: string) =>
      link.startsWith(DEEPSEEK_SESSION_PREFIX)
        ? link.slice(DEEPSEEK_SESSION_PREFIX.length)
        : undefined,
  },
} as const satisfies Record<string, OxapHarness>;

export type OxapHarnessId = keyof typeof OXAP_HARNESSES;

export function isOxapHarness(harness: unknown): harness is OxapHarnessId {
  return typeof harness === 'string' && Object.hasOwn(OXAP_HARNESSES, harness);
}

export function oxapHarness(harness: OxapHarnessId): OxapHarness {
  return OXAP_HARNESSES[harness];
}

export function oxapHarnessesForProvider(provider: string): OxapHarnessId[] {
  return Object.keys(OXAP_HARNESSES)
    .filter(isOxapHarness)
    .filter((harness) => oxapHarness(harness).providers.includes(provider));
}

export function oxapSupportsImages(harness: OxapHarnessId, model: string | undefined): boolean {
  return (
    harness === 'oxap-deepseek' &&
    (model === 'deepseek-flash' ||
      model === 'deepseek-v4-flash' ||
      model === 'deepseek-v4-flash-vision-exp')
  );
}

export function isOxapModelLocked(
  harness: unknown,
  nativeSessionId: string | null | undefined
): boolean {
  return harness === 'oxap-deepseek' && !!nativeSessionId;
}

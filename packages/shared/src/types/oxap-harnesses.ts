import type { ModelInfo } from '../models.ts';
import { THINKING_OPTIONS, type ThinkingLevel } from '../types.ts';

export type OxapInitDetails = {
  client: string;
  version: string;
  contextWindow?: number;
};

export type OxapHarness = {
  label: string;
  adapter: string;
  providers: readonly string[];
  thinking: boolean;
  settings: readonly string[];
  environment: readonly string[];
  key?: string;
  approvalPolicy?: string;
  entry: (
    settings: Readonly<Record<string, string>>,
    environment: readonly string[],
    stateDirectory: string
  ) => Record<string, unknown>;
  nativeId: (link: string) => string | undefined;
};

const CODEX_APPROVAL_POLICY = 'on-request';
const DEEPSEEK_SESSION_PREFIX = 'deepseek://sessions/';
export const OPENCODE_DSH_OVERLAY = 'opencode-go.dsh.json';

function deepSeekNativeId(link: string): string | undefined {
  return link.startsWith(DEEPSEEK_SESSION_PREFIX)
    ? link.slice(DEEPSEEK_SESSION_PREFIX.length)
    : undefined;
}

export function oxapModelProvider(settings: Readonly<Record<string, string>>): string | undefined {
  const value = settings.model_provider;
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

export const OXAP_HARNESSES = {
  'oxap-codex': {
    label: 'OXAP Codex',
    adapter: 'codex',
    providers: ['anthropic-codex'],
    thinking: true,
    settings: ['executable'],
    environment: ['HOME', 'CODEX_HOME'],
    approvalPolicy: CODEX_APPROVAL_POLICY,
    entry: (settings: Readonly<Record<string, string>>, environment: readonly string[]) => ({
      type: 'codex',
      executable: settings.executable,
      environment,
      any_directory: true,
      approval_policy: CODEX_APPROVAL_POLICY,
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
      model_provider: oxapModelProvider(settings),
      model: 'deepseek-v4-pro',
    }),
    nativeId: deepSeekNativeId,
  },
  'oxap-opencode-dsh': {
    label: 'OXAP DeepSeek',
    adapter: 'deepseek',
    providers: ['opencode'],
    thinking: false,
    settings: ['executable'],
    environment: ['HOME', 'PATH'],
    key: 'OPENCODE_API_KEY',
    entry: (
      settings: Readonly<Record<string, string>>,
      environment: readonly string[],
      stateDirectory: string
    ) => ({
      type: 'deepseek',
      executable: settings.executable,
      args: ['--profile', 'sdk', '--patch', `${stateDirectory}/${OPENCODE_DSH_OVERLAY}`],
      environment: [...environment, `DSH_HOME=${stateDirectory}/opencode-dsh`],
      any_directory: true,
      provider: 'opencode-go',
      model: 'deepseek-v4-pro',
    }),
    nativeId: deepSeekNativeId,
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
  return !!nativeSessionId && isOxapHarness(harness) && oxapHarness(harness).adapter === 'deepseek';
}

const codexEfforts: Partial<Record<ThinkingLevel, string>> = {
  off: 'none',
  think8k: 'low',
  think16k: 'medium',
  think24k: 'high',
  think32k: 'xhigh',
  think48k: 'max',
};

export function oxapThinkingOptions(harness: unknown, model: ModelInfo | null | undefined) {
  if (!isOxapHarness(harness)) return THINKING_OPTIONS;
  if (harness !== 'oxap-codex') return [];
  return THINKING_OPTIONS.flatMap(({ value }) => {
    const label = codexEfforts[value];
    return label && model?.codexReasoning?.levels.includes(label) ? [{ value, label }] : [];
  });
}

export function oxapCodexReasoning(level: ThinkingLevel | undefined): string | undefined {
  const effort = level && codexEfforts[level];
  return effort === 'none' ? 'off' : effort;
}

export function oxapCodexDefaultThinking(model: ModelInfo | null | undefined) {
  return oxapThinkingOptions('oxap-codex', model).find(
    ({ value }) => codexEfforts[value] === model?.codexReasoning?.defaultLevel
  )?.value;
}

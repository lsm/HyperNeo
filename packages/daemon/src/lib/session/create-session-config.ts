import type { SessionConfig } from '@hyperneo/shared';
import { isDeepStrictEqual } from 'node:util';
import { codexSessionRefusal, selectSessionEngine } from '../agent/session-engine.ts';

export type CreateSessionConfigFieldPolicy = 'derived' | 'carried' | 'creation-only' | 'rejected';

export const CREATE_SESSION_CONFIG_FIELD_POLICY: Record<
  keyof SessionConfig,
  CreateSessionConfigFieldPolicy
> = {
  model: 'derived',
  provider: 'derived',
  maxTokens: 'derived',
  temperature: 'derived',
  autoScroll: 'derived',
  thinkingLevel: 'derived',
  autoCompactPercent: 'carried',
  autoCompactWindow: 'carried',
  coordinatorMode: 'derived',
  sandbox: 'derived',
  settingSources: 'derived',

  systemPrompt: 'carried',
  tools: 'carried',
  sdkToolsPreset: 'carried',
  allowedTools: 'carried',
  disallowedTools: 'carried',
  agent: 'carried',
  agents: 'carried',
  toolGuards: 'carried',
  features: 'carried',
  permissionMode: 'carried',
  mcpServers: 'carried',
  strictMcpConfig: 'carried',
  providerConfig: 'carried',
  fallbackModel: 'carried',
  maxTurns: 'carried',
  maxBudgetUsd: 'carried',
  maxThinkingTokens: 'carried',
  thinking: 'carried',
  outputFormat: 'carried',
  betas: 'carried',
  additionalDirectories: 'carried',
  includePartialMessages: 'carried',
  enableFileCheckpointing: 'carried',
  queryMode: 'carried',
  chatDisplayMode: 'carried',
  workerOperations: 'carried',

  harness: 'creation-only',
  cwd: 'rejected',
  env: 'rejected',
  executable: 'rejected',
  executableArgs: 'rejected',
  pathToClaudeCodeExecutable: 'rejected',
  plugins: 'rejected',
  allowDangerouslySkipPermissions: 'rejected',
  spawnClaudeCodeProcess: 'rejected',
  resume: 'rejected',
  resumeSessionAt: 'rejected',
  forkSession: 'rejected',
  continue: 'rejected',
  type: 'rejected',
  context: 'rejected',
  toolSelection: 'rejected',
  toolProfile: 'rejected',
};

export function hasExplicitAutoCompactWindow(
  config: Pick<SessionConfig, 'autoCompactWindow'>
): config is { autoCompactWindow: number } {
  const window = config.autoCompactWindow;
  return typeof window === 'number' && Number.isSafeInteger(window) && window > 0;
}

export function hasExplicitAutoCompactChoice(
  config: Pick<SessionConfig, 'autoCompactWindow' | 'autoCompactPercent'>
): boolean {
  if (hasExplicitAutoCompactWindow(config)) return true;
  const percent = config.autoCompactPercent;
  return typeof percent === 'number' && Number.isFinite(percent) && percent > 0;
}

function fieldsWithPolicy(policy: CreateSessionConfigFieldPolicy): (keyof SessionConfig)[] {
  return (Object.keys(CREATE_SESSION_CONFIG_FIELD_POLICY) as (keyof SessionConfig)[]).filter(
    (field) => CREATE_SESSION_CONFIG_FIELD_POLICY[field] === policy
  );
}

const CARRIED_FIELDS = [...fieldsWithPolicy('carried'), ...fieldsWithPolicy('creation-only')];
const REJECTED_FIELDS = fieldsWithPolicy('rejected');
const UPDATE_REJECTED_FIELDS = [...REJECTED_FIELDS, ...fieldsWithPolicy('creation-only')];

export const UPDATABLE_SESSION_CONFIG_FIELDS: (keyof SessionConfig)[] = (
  Object.keys(CREATE_SESSION_CONFIG_FIELD_POLICY) as (keyof SessionConfig)[]
).filter((field) => !UPDATE_REJECTED_FIELDS.includes(field));

export type SessionConfigDoor = 'Session creation' | 'Session update';

export class UnsupportedSessionConfigFieldsError extends Error {
  constructor(
    public readonly fields: (keyof SessionConfig)[],
    door: SessionConfigDoor = 'Session creation'
  ) {
    super(
      `${door} does not accept config field(s): ${fields.join(', ')}. ` +
        'These control the host process or session identity and are owned by the daemon.'
    );
    this.name = 'UnsupportedSessionConfigFieldsError';
  }
}

export function stripRejectedSessionConfig(config: SessionConfig): SessionConfig {
  if (config.executable !== undefined && !['bun', 'node'].includes(config.executable))
    throw new Error(`Unsupported stored SDK executable: ${String(config.executable)}`);
  const stored = REJECTED_FIELDS.filter((field) => config[field] !== undefined);
  if (stored.length === 0) return config;

  const admitted = { ...config } as SessionConfig & Record<string, unknown>;
  for (const field of stored) {
    delete admitted[field as string];
  }
  return admitted;
}

export function admitCreateSessionConfig(
  requested: Partial<SessionConfig> | undefined
): Partial<SessionConfig> {
  if (!requested) return {};
  if (requested.harness !== undefined && selectSessionEngine(requested.harness) === 'codex') {
    const refusal = codexSessionRefusal(requested, false, false);
    if (refusal) throw new Error(refusal);
  }

  const rejected = REJECTED_FIELDS.filter((field) => requested[field] !== undefined);
  if (rejected.length > 0) {
    throw new UnsupportedSessionConfigFieldsError(rejected);
  }

  const carried: Record<string, unknown> = {};
  for (const field of CARRIED_FIELDS) {
    const value = requested[field];
    if (value === undefined) continue;
    carried[field] = value;
  }
  return carried as Partial<SessionConfig>;
}

export function admitUpdateSessionConfig(
  requested: Partial<SessionConfig> | undefined,
  currentSelection?: SessionConfig['toolSelection'],
  currentHarness?: SessionConfig['harness']
): Partial<SessionConfig> | undefined {
  if (!requested) return requested;
  if (currentHarness === 'codex') {
    const refusal = codexSessionRefusal(requested, false, false);
    if (refusal) throw new Error(refusal);
  }

  const rejected = UPDATE_REJECTED_FIELDS.filter(
    (field) =>
      requested[field] !== undefined &&
      !(
        field === 'toolSelection' &&
        currentSelection !== undefined &&
        isDeepStrictEqual(requested.toolSelection, currentSelection)
      )
  );
  if (rejected.length > 0) {
    throw new UnsupportedSessionConfigFieldsError(rejected, 'Session update');
  }

  const admitted: Record<string, unknown> = {};
  for (const field of UPDATABLE_SESSION_CONFIG_FIELDS) {
    if (!(field in requested)) continue;
    admitted[field] = requested[field];
  }
  return admitted as Partial<SessionConfig>;
}

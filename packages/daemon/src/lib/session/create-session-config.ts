import type { SessionConfig } from '@hyperneo/shared';

export type CreateSessionConfigFieldPolicy = 'derived' | 'carried' | 'rejected';

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
  workerOperations: 'carried',

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
};

function fieldsWithPolicy(policy: CreateSessionConfigFieldPolicy): (keyof SessionConfig)[] {
  return (Object.keys(CREATE_SESSION_CONFIG_FIELD_POLICY) as (keyof SessionConfig)[]).filter(
    (field) => CREATE_SESSION_CONFIG_FIELD_POLICY[field] === policy
  );
}

const CARRIED_FIELDS = fieldsWithPolicy('carried');
const REJECTED_FIELDS = fieldsWithPolicy('rejected');

export const UPDATABLE_SESSION_CONFIG_FIELDS: (keyof SessionConfig)[] = (
  Object.keys(CREATE_SESSION_CONFIG_FIELD_POLICY) as (keyof SessionConfig)[]
).filter((field) => CREATE_SESSION_CONFIG_FIELD_POLICY[field] !== 'rejected');

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

export function admitCreateSessionConfig(
  requested: Partial<SessionConfig> | undefined
): Partial<SessionConfig> {
  if (!requested) return {};

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
  requested: Partial<SessionConfig> | undefined
): Partial<SessionConfig> | undefined {
  if (!requested) return requested;

  const rejected = REJECTED_FIELDS.filter((field) => requested[field] !== undefined);
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

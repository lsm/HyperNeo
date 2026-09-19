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

export class UnsupportedSessionConfigFieldsError extends Error {
  constructor(public readonly fields: (keyof SessionConfig)[]) {
    super(
      `Session creation does not accept config field(s): ${fields.join(', ')}. ` +
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

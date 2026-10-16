import type {
  AgentModelPoolEntry,
  SettingSource,
  SpaceLongHorizonAgent,
  SpaceLongHorizonAgentStatus,
  ThinkingLevel,
} from '@hyperneo/shared';

export interface WorkerAgentRowSource {
  id: string;
  spaceId: string;
  name: string;
  handle?: string | null;
  status?: string | null;
  description?: string | null;
  model?: string | null;
  thinkingLevel?: ThinkingLevel | null;
  provider?: string | null;
  customPrompt?: string | null;
  instructions?: string | null;
  systemPrompt?: string | null;
  tools?: readonly string[] | null;
  settingSources?: readonly SettingSource[] | null;
  modelPool?: readonly AgentModelPoolEntry[] | null;
  createdAt?: number | null;
}

export interface WorkerAgentToLongHorizonParams {
  id: string;
  spaceId: string;
  handle: string;
  displayName: string;
  templateKey: string;
  status: SpaceLongHorizonAgentStatus;
  sessionId: null;
  instructions: string;
  autonomyLevel: null;
  model: string | null;
  thinkingLevel: ThinkingLevel | null;
  provider: string | null;
  settingSources: SettingSource[] | null;
  toolPermissions: Record<string, unknown>;
  description: string | undefined;
  modelPool: readonly AgentModelPoolEntry[] | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface WorkerAgentToLongHorizonOptions {
  occupiedHandles: ReadonlySet<string>;
  now: number;
}

export const MIGRATED_WORKER_TEMPLATE_KEY = 'migration.legacy_space_agent';

export function isRunnableUnifiedAgent(agent: SpaceLongHorizonAgent): boolean {
  if (agent.templateKey === MIGRATED_WORKER_TEMPLATE_KEY) return true;
  return agent.status === 'active';
}

export function unifiedAgentRecordExists(
  unified: SpaceLongHorizonAgent,
  expectedSpaceId: string | undefined
): boolean {
  if (expectedSpaceId && unified.spaceId !== expectedSpaceId) return false;
  return isRunnableUnifiedAgent(unified);
}

import type { ThinkingLevel } from '../types.ts';
import type { SettingSource } from './settings.ts';
import type { AgentModelPoolEntry, SpaceAgentAutonomyLevel } from './space.ts';

export type SpaceAgentStatus = 'active' | 'paused' | 'disabled' | 'archived';

export const DEFAULT_SEED_AGENT_TEMPLATE_KEY = 'task-manager.default';

export interface SpaceAgent {
  id: string;
  spaceId: string;
  handle: string;
  displayName: string;
  description: string | null;
  instructions: string;
  status: SpaceAgentStatus;
  sessionId: string | null;
  autonomyLevel: SpaceAgentAutonomyLevel | null;
  model: string | null;
  provider: string | null;
  modelPool: AgentModelPoolEntry[] | null;
  thinkingLevel: ThinkingLevel | null;
  settingSources: SettingSource[] | null;
  tools: string[] | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSpaceAgentParams {
  id?: string;
  spaceId: string;
  handle: string;
  displayName?: string;
  description?: string | null;
  instructions?: string;
  status?: SpaceAgentStatus;
  sessionId?: string | null;
  autonomyLevel?: SpaceAgentAutonomyLevel | null;
  model?: string | null;
  provider?: string | null;
  modelPool?: AgentModelPoolEntry[] | null;
  thinkingLevel?: ThinkingLevel | null;
  settingSources?: SettingSource[] | null;
  tools?: string[] | null;
}

export interface UpdateSpaceAgentParams {
  handle?: string;
  displayName?: string;
  description?: string | null;
  instructions?: string;
  status?: SpaceAgentStatus;
  sessionId?: string | null;
  autonomyLevel?: SpaceAgentAutonomyLevel | null;
  model?: string | null;
  provider?: string | null;
  modelPool?: AgentModelPoolEntry[] | null;
  thinkingLevel?: ThinkingLevel | null;
  settingSources?: SettingSource[] | null;
  tools?: string[] | null;
}

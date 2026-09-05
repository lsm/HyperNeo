import type {
  CreateSpaceAgentTemplateParams,
  SettingSource,
  SpaceAgentAutonomyLevel,
  ThinkingLevel,
  WorkerAgentModelPoolEntry,
} from '@hyperneo/shared';
import { slugifyWithinLimit } from '../slug.ts';

export const MIGRATED_AGENT_TEMPLATE_KEY_PREFIX = 'migrated.agent';

export interface AgentTemplateSynthesisInput {
  id: string;
  displayName: string;
  handle: string | null;
  description: string | null;
  instructions: string;
  model: string | null;
  provider: string | null;
  thinkingLevel: string | null;
  settingSources: SettingSource[] | null;
  tools: string[] | null;
  modelPool: WorkerAgentModelPoolEntry[] | null;
  autonomyLevel: number | null;
}

export interface OrphanAgentSlotSource {
  name: string;
  model: string | null;
  thinkingLevel: string | null;
}

export function migratedAgentTemplateKey(agentId: string): string {
  return `${MIGRATED_AGENT_TEMPLATE_KEY_PREFIX}.${agentId}`;
}

export function synthesizeAgentTemplate(
  input: AgentTemplateSynthesisInput
): CreateSpaceAgentTemplateParams {
  return {
    key: migratedAgentTemplateKey(input.id),
    handle: slugifyWithinLimit(input.handle?.trim() || input.displayName),
    displayName: input.displayName,
    description: input.description ?? '',
    instructions: input.instructions ?? '',
    suggestedAutonomyLevel: clampAutonomyLevel(input.autonomyLevel),
    model: input.model,
    provider: input.provider,
    modelPool: input.modelPool,
    thinkingLevel: input.thinkingLevel as ThinkingLevel | null,
    settingSources: input.settingSources,
    tools: input.tools,
  };
}

export function synthesizeOrphanAgentTemplate(
  agentId: string,
  slot: OrphanAgentSlotSource
): CreateSpaceAgentTemplateParams {
  const displayName = slot.name.trim() || agentId;
  return {
    key: migratedAgentTemplateKey(agentId),
    handle: slugifyWithinLimit(displayName),
    displayName,
    description: '',
    instructions: '',
    suggestedAutonomyLevel: 2,
    model: slot.model,
    provider: null,
    modelPool: null,
    thinkingLevel: slot.thinkingLevel as ThinkingLevel | null,
    settingSources: null,
    tools: null,
  };
}

function clampAutonomyLevel(level: number | null): SpaceAgentAutonomyLevel {
  if (level != null && Number.isInteger(level) && level >= 1 && level <= 5) {
    return level as SpaceAgentAutonomyLevel;
  }
  return 2;
}

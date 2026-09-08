import type {
  AgentModelPoolEntry,
  CreateSpaceAgentTemplateParams,
  SettingSource,
  SpaceAgentAutonomyLevel,
  ThinkingLevel,
} from '@hyperneo/shared';
import { slugifyWithinLimit } from '../slug.ts';

export interface AgentTemplateDerivationSource {
  displayName: string;
  handle: string | null;
  description: string | null;
  instructions: string;
  model: string | null;
  provider: string | null;
  thinkingLevel: string | null;
  settingSources: SettingSource[] | null;
  tools: string[] | null;
  modelPool: AgentModelPoolEntry[] | null;
  autonomyLevel: number | null;
}

export interface DeriveAgentTemplateOptions {
  key: string;
  emptyInstructions?: string;
}

export function deriveAgentTemplate(
  source: AgentTemplateDerivationSource,
  options: DeriveAgentTemplateOptions
): CreateSpaceAgentTemplateParams {
  const emptyInstructions =
    options.emptyInstructions ??
    `You are ${source.displayName}. Carry out the tasks assigned to you in this Space.`;
  return {
    key: options.key,
    handle: slugifyWithinLimit(source.handle?.trim() || source.displayName),
    displayName: source.displayName,
    description: source.description ?? '',
    instructions: source.instructions || emptyInstructions,
    suggestedAutonomyLevel: clampAutonomyLevel(source.autonomyLevel),
    model: source.model,
    provider: source.provider,
    modelPool: source.modelPool,
    thinkingLevel: source.thinkingLevel as ThinkingLevel | null,
    settingSources: source.settingSources,
    tools: source.tools,
  };
}

function clampAutonomyLevel(level: number | null): SpaceAgentAutonomyLevel {
  if (level != null && Number.isInteger(level) && level >= 1 && level <= 5) {
    return level as SpaceAgentAutonomyLevel;
  }
  return 2;
}

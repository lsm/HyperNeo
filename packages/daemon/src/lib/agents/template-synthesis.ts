import type { CreateSpaceAgentTemplateParams } from '@hyperneo/shared';
import { type AgentTemplateDerivationSource, deriveAgentTemplate } from './template-derivation.ts';

export const MIGRATED_AGENT_TEMPLATE_KEY_PREFIX = 'migrated.agent';

export interface AgentTemplateSynthesisInput extends AgentTemplateDerivationSource {
  id: string;
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
  return deriveAgentTemplate(input, {
    key: migratedAgentTemplateKey(input.id),
    emptyInstructions: '',
  });
}

export function synthesizeOrphanAgentTemplate(
  agentId: string,
  slot: OrphanAgentSlotSource
): CreateSpaceAgentTemplateParams {
  const displayName = slot.name.trim() || agentId;
  return deriveAgentTemplate(
    {
      displayName,
      handle: null,
      description: null,
      instructions: '',
      model: slot.model,
      provider: null,
      thinkingLevel: slot.thinkingLevel,
      settingSources: null,
      tools: null,
      modelPool: null,
      autonomyLevel: null,
    },
    { key: migratedAgentTemplateKey(agentId), emptyInstructions: '' }
  );
}

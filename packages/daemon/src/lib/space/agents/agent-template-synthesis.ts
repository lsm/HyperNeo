import type { CreateSpaceAgentTemplateParams, SpaceLongHorizonAgent } from '@hyperneo/shared';
import { type AgentTemplateDerivationSource, deriveAgentTemplate } from './template-derivation.ts';

export const MIGRATED_AGENT_TEMPLATE_KEY_PREFIX = 'migrated.agent';
export const WORKER_CUSTOM_TEMPLATE_KEY_PREFIX = 'worker-custom';

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

export function workerCustomTemplateKey(agentId: string): string {
  return `${WORKER_CUSTOM_TEMPLATE_KEY_PREFIX}.${agentId}`;
}

export function isMigrationIdentityKey(
  templateKey: string,
  prefix: string,
  agentId: string,
  tag: string
): boolean {
  const stem = `${prefix}.${agentId}`;
  if (templateKey === stem) return true;
  if (!templateKey.startsWith(`${stem}.`)) return false;
  const suffix = templateKey.slice(stem.length + 1);
  return suffix === tag || new RegExp(`^${tag}-\\d+$`).test(suffix);
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

function toolsFromPermissions(
  permissions: Record<string, unknown> | null | undefined
): string[] | null {
  const raw = (permissions ?? {}) as Record<string, unknown>;
  const tools = raw.tools;
  if (!Array.isArray(tools)) return null;
  const filtered = tools.filter((tool): tool is string => typeof tool === 'string');
  return filtered.length > 0 ? filtered : null;
}

export function synthesizeWorkerCustomTemplate(
  agent: SpaceLongHorizonAgent
): CreateSpaceAgentTemplateParams {
  return {
    ...deriveAgentTemplate(
      {
        displayName: agent.displayName,
        handle: agent.handle,
        description: agent.description ?? null,
        instructions: agent.instructions ?? '',
        model: agent.model,
        provider: agent.provider,
        thinkingLevel: agent.thinkingLevel,
        settingSources: agent.settingSources ?? null,
        tools: toolsFromPermissions(agent.toolPermissions),
        modelPool: agent.modelPool ?? null,
        autonomyLevel: agent.autonomyLevel,
      },
      { key: workerCustomTemplateKey(agent.id), emptyInstructions: '' }
    ),
    labels: ['workflow-worker'],
  };
}

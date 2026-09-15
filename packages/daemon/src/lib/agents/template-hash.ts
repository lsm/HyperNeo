import { createHash } from 'node:crypto';

export interface AgentTemplateInput {
  name: string;
  description: string;
  tools: string[];
  customPrompt: string;
}

export interface AgentTemplateFingerprint {
  name: string;
  description: string;
  tools: string[];
  customPrompt: string;
}

export function buildAgentTemplateFingerprint(agent: AgentTemplateInput): AgentTemplateFingerprint {
  return {
    name: (agent.name ?? '').trim().toLowerCase(),
    description: agent.description ?? '',
    tools: [...(agent.tools ?? [])].sort(),
    customPrompt: agent.customPrompt ?? '',
  };
}

export function computeAgentTemplateHash(agent: AgentTemplateInput): string {
  const fp = buildAgentTemplateFingerprint(agent);
  const json = JSON.stringify(fp);
  return createHash('sha256').update(json).digest('hex');
}

export function agentTemplatesMatch(a: AgentTemplateInput, b: AgentTemplateInput): boolean {
  return computeAgentTemplateHash(a) === computeAgentTemplateHash(b);
}

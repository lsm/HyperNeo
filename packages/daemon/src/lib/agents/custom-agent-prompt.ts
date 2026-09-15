import { createHash } from 'node:crypto';
import type { PromptProvenanceInit } from '../agent/agent-session.ts';
import type { SlotOverrides, UnifiedSpaceAgent } from './custom-agent-types.ts';

export type PromptSource =
  | 'workflow_node_custom_prompt'
  | 'workflow_node_replaced_prompt'
  | 'space_agent_custom_prompt'
  | 'empty';

export interface ResolvedAgentPrompt {
  value: string;
  source: PromptSource;
  hash: string;
}

function unifiedAgentDisplayName(agent: UnifiedSpaceAgent): string {
  return agent.displayName;
}

function unifiedAgentInstructions(agent: UnifiedSpaceAgent): string {
  return agent.instructions;
}

export function expandPrompt(
  base: string | null | undefined,
  expansion: string | null | undefined
): string {
  const trimmedBase = base?.trim() ?? '';
  const trimmedExpansion = expansion?.trim() ?? '';
  if (!trimmedExpansion) return trimmedBase;
  if (!trimmedBase) return trimmedExpansion;
  return `${trimmedBase}\n\n${trimmedExpansion}`;
}

export function buildCustomAgentSystemPrompt(
  customAgent: UnifiedSpaceAgent,
  slotOverrides?: SlotOverrides
): string {
  return resolveCustomAgentPrompt(customAgent, slotOverrides).value;
}

export function resolveCustomAgentPrompt(
  customAgent: UnifiedSpaceAgent,
  slotOverrides?: SlotOverrides
): ResolvedAgentPrompt {
  const basePrompt = unifiedAgentInstructions(customAgent).trim();
  const slotPrompt = slotOverrides?.customPrompt?.trim() ?? '';
  const replace = slotOverrides?.replaceAgentPrompt === true;
  let value: string;
  let source: PromptSource;
  if (replace) {
    value = slotPrompt;
    source = slotPrompt ? 'workflow_node_replaced_prompt' : 'empty';
  } else {
    value = expandPrompt(basePrompt, slotPrompt);
    source = slotPrompt
      ? 'workflow_node_custom_prompt'
      : basePrompt
        ? 'space_agent_custom_prompt'
        : 'empty';
  }
  return { value, source, hash: hashPrompt(value) };
}

export function buildPromptProvenance(
  resolved: ResolvedAgentPrompt,
  customAgent: UnifiedSpaceAgent,
  slotOverrides?: SlotOverrides
): PromptProvenanceInit {
  const ctx = slotOverrides?.resolutionContext;
  return {
    source: resolved.source,
    hash: resolved.hash,
    agentId: ctx?.agentId ?? customAgent.id,
    agentName: ctx?.agentName ?? unifiedAgentDisplayName(customAgent),
    workflowRunId: ctx?.workflowRunId,
    workflowId: ctx?.workflowId,
    nodeId: ctx?.nodeId,
    nodeName: ctx?.nodeName,
  };
}

function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

import { NON_DELEGATING_GENERAL_PROMPT } from '@hyperneo/prompts';
import type { AgentSessionInit, PromptProvenanceInit } from '../agent/agent-session.ts';
import type {
  AgentDefinition,
  Space,
  SpaceLongHorizonAgent,
  SpaceTask,
  SpaceWorkflow,
  SpaceWorkflowRun,
} from '@hyperneo/shared';
import type { SkillEnablementOverride } from '@hyperneo/shared';
import { isScopedBashToolEntry } from '@hyperneo/shared';
import { Logger } from '../logger.ts';
import { inferProviderForModel } from '../providers/registry.js';
import { buildPromptProvenance, resolveCustomAgentPrompt } from './custom-agent-prompt.ts';
import type { CustomAgentConfig, SlotOverrides, UnifiedSpaceAgent } from './custom-agent-types.ts';
import { SUB_SESSION_FEATURES } from './seed-agents.ts';
import { deriveWorkerDisallowedTools } from './tool-policy.ts';

export type {
  CustomAgentConfig,
  SlotOverrides,
  SlotResolutionContext,
  TaskMessageContext,
  UnifiedSpaceAgent,
} from './custom-agent-types.ts';
export type { PromptSource, ResolvedAgentPrompt } from './custom-agent-prompt.ts';
export {
  buildCustomAgentSystemPrompt,
  expandPrompt,
  resolveCustomAgentPrompt,
} from './custom-agent-prompt.ts';
export { buildCustomAgentTaskMessage, labelVerificationImplementerFacing } from './task-message.ts';

export const DEFAULT_CUSTOM_AGENT_MODEL = 'claude-sonnet-4-6';

export const NON_DELEGATING_GENERAL_AGENT: AgentDefinition = {
  description:
    'Investigate a focused question using files, search, shell commands, and web sources. Complete the assigned work directly; do not delegate it to another agent.',
  tools: ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch'],
  disallowedTools: ['Agent', 'Task', 'TaskOutput', 'TaskStop'],
  prompt: NON_DELEGATING_GENERAL_PROMPT,
  model: 'inherit',
};

const log = new Logger('custom-agent');

function unifiedAgentTools(agent: UnifiedSpaceAgent): string[] {
  const tools = agent.toolPermissions.tools;
  return Array.isArray(tools)
    ? tools.filter((tool): tool is string => typeof tool === 'string')
    : [];
}

export function createCustomAgentInit(config: CustomAgentConfig): AgentSessionInit {
  const { customAgent, task, space, sessionId, workspacePath, slotOverrides } = config;

  const customTools = unifiedAgentTools(customAgent);
  const customDisallowedBuiltins = deriveWorkerDisallowedTools(customTools);
  const customAgentInvocationTools = customTools?.filter((tool) =>
    ['Task', 'TaskOutput', 'TaskStop'].includes(tool)
  );
  const scopedBashToolEntries = customTools?.filter((tool) => isScopedBashToolEntry(tool));
  const allowedToolEntries = [
    ...(customAgentInvocationTools ?? []),
    ...(scopedBashToolEntries ?? []),
  ];
  const customToolPermissions = {
    ...(allowedToolEntries.length > 0 ? { allowedTools: allowedToolEntries } : {}),
    ...(customDisallowedBuiltins.length > 0 ? { disallowedTools: customDisallowedBuiltins } : {}),
  };
  const model =
    slotOverrides?.model ?? customAgent.model ?? space.defaultModel ?? DEFAULT_CUSTOM_AGENT_MODEL;
  const thinkingLevel = slotOverrides?.thinkingLevel ?? customAgent.thinkingLevel ?? undefined;
  const acpProviderId = inferProviderForModel(model) === 'acp' ? 'acp' : undefined;
  const provider = slotOverrides?.model
    ? (slotOverrides?.provider ?? acpProviderId)
    : (slotOverrides?.provider ?? customAgent.provider ?? acpProviderId);

  const resolvedPrompt = resolveCustomAgentPrompt(customAgent, slotOverrides);
  const visiblePrompt = resolvedPrompt.value;
  const promptProvenance = buildPromptProvenance(resolvedPrompt, customAgent, slotOverrides);
  emitPromptProvenance('createCustomAgentInit', promptProvenance);

  const skillOverrides: SkillEnablementOverride[] | undefined = slotOverrides?.disabledSkillIds
    ?.length
    ? slotOverrides.disabledSkillIds.map((id) => ({ skillId: id, enabled: false }))
    : undefined;

  const extraMcpServers = slotOverrides?.extraMcpServers;
  const toolGuards = slotOverrides?.toolGuards;

  return {
    sessionId,
    workspacePath,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: visiblePrompt,
    },
    features: SUB_SESSION_FEATURES,
    context: { spaceId: space.id, taskId: task.id },
    type: 'worker',
    promptProvenance,
    model,
    provider,
    thinkingLevel,
    ...customToolPermissions,
    agents: { 'general-purpose': NON_DELEGATING_GENERAL_AGENT },
    skillOverrides,
    mcpServers: extraMcpServers,
    settingSources: customAgent.settingSources ?? space.settingSources,
    toolGuards,
  };
}

export interface ResolveAgentInitConfig {
  task: SpaceTask;
  space: Space;
  agent: SpaceLongHorizonAgent | null;
  sessionId: string;
  workspacePath: string;
  workflowRun?: SpaceWorkflowRun | null;
  workflow?: SpaceWorkflow | null;
  previousTaskSummaries?: string[];
  slotOverrides?: SlotOverrides;
  agentId: string;
}

export function resolveAgentInit(config: ResolveAgentInitConfig): AgentSessionInit {
  const {
    task,
    space,
    agent,
    sessionId,
    workspacePath,
    workflowRun,
    workflow,
    previousTaskSummaries,
    slotOverrides,
  } = config;

  if (!agent) {
    throw new Error(`Agent not found: ${config.agentId} (task: ${task.id})`);
  }

  return createCustomAgentInit({
    customAgent: agent,
    task,
    workflowRun: workflowRun ?? null,
    workflow: workflow ?? null,
    space,
    sessionId,
    workspacePath,
    previousTaskSummaries,
    slotOverrides,
  });
}

function emitPromptProvenance(event: string, provenance: PromptProvenanceInit): void {
  log.info(
    `${event}: prompt source=${provenance.source} hash=${provenance.hash} ` +
      `agentId=${provenance.agentId ?? 'unknown'} agentName=${provenance.agentName ?? 'unknown'} ` +
      `workflowRunId=${provenance.workflowRunId ?? 'none'} nodeId=${provenance.nodeId ?? 'none'} ` +
      `nodeName=${provenance.nodeName ?? 'none'}`
  );
}

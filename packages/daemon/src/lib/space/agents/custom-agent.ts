import type { AgentSessionInit, PromptProvenanceInit } from '../../agent/agent-session';
import type {
  AgentDefinition,
  DeclarativeToolGuard,
  McpServerConfig,
  EvolutionLesson,
  Space,
  SpaceWorkerAgent,
  SpaceGoal,
  SpaceTask,
  SpaceWorkflow,
  SpaceWorkflowRun,
  WorkflowChannel,
  WorkflowNode,
} from '@hyperneo/shared';
import type { SkillEnablementOverride } from '@hyperneo/shared';
import { isScopedBashToolEntry } from '@hyperneo/shared';
import type {
  AgentMemoryCoreEntry,
  AgentMemorySearchResult,
} from '../../../storage/repositories/agent-memory-repository';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import { inferProviderForModel } from '../../providers/registry';
import { Logger } from '../../logger';
import { SUB_SESSION_FEATURES } from './seed-agents';
import { deriveWorkerDisallowedTools } from './tool-policy';
import { createHash } from 'node:crypto';

const DEFAULT_CUSTOM_AGENT_MODEL = 'claude-sonnet-4-6';

export const NON_DELEGATING_GENERAL_AGENT: AgentDefinition = {
  description:
    'Investigate a focused question using files, search, shell commands, and web sources. Complete the assigned work directly; do not delegate it to another agent.',
  tools: ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch'],
  disallowedTools: ['Agent', 'Task', 'TaskOutput', 'TaskStop'],
  prompt:
    'Complete the assigned investigation directly. You may use the available read, search, shell, and web tools, but you must not spawn or delegate to other agents.',
  model: 'inherit',
};

const USER_MESSAGE_SOFT_LIMIT_BYTES = 4 * 1024;
const MEMORY_PROMPT_CONTENT_LIMIT = 500;
const CORE_MEMORY_PROMPT_CHAR_LIMIT = 2_000;
const OVERSIZED_NEWEST_PREVIOUS_WORK_LIMIT = 2_000;

const log = new Logger('custom-agent');

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

export interface SlotResolutionContext {
  agentId?: string;
  agentName?: string;
  workflowRunId?: string;
  workflowId?: string;
  nodeId?: string;
  nodeName?: string;
}

export interface SlotOverrides {
  model?: string;
  thinkingLevel?: SpaceWorkerAgent['thinkingLevel'];
  customPrompt?: string;
  replaceAgentPrompt?: boolean;
  disabledSkillIds?: string[];
  extraMcpServers?: Record<string, McpServerConfig>;
  toolGuards?: DeclarativeToolGuard[];
  resolutionContext?: SlotResolutionContext;
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

export interface CustomAgentConfig {
  customAgent: SpaceWorkerAgent;
  task: SpaceTask;
  workflowRun: SpaceWorkflowRun | null;
  workflow?: SpaceWorkflow | null;
  space: Space;
  sessionId: string;
  workspacePath: string;
  goal?: SpaceGoal | null;
  relevantScopeLessons?: EvolutionLesson[];
  previousTaskSummaries?: string[];
  slotOverrides?: SlotOverrides;
  nodeId?: string;
  agentSlotName?: string;
  coreMemories?: AgentMemoryCoreEntry[];
  relevantMemories?: AgentMemorySearchResult[];
}

export function buildCustomAgentSystemPrompt(
  customAgent: SpaceWorkerAgent,
  slotOverrides?: SlotOverrides
): string {
  return resolveCustomAgentPrompt(customAgent, slotOverrides).value;
}

export function resolveCustomAgentPrompt(
  customAgent: SpaceWorkerAgent,
  slotOverrides?: SlotOverrides
): ResolvedAgentPrompt {
  const basePrompt = customAgent.customPrompt?.trim() ?? '';
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

function buildPromptProvenance(
  resolved: ResolvedAgentPrompt,
  customAgent: SpaceWorkerAgent,
  slotOverrides?: SlotOverrides
): PromptProvenanceInit {
  const ctx = slotOverrides?.resolutionContext;
  return {
    source: resolved.source,
    hash: resolved.hash,
    agentId: ctx?.agentId ?? customAgent.id,
    agentName: ctx?.agentName ?? customAgent.name,
    workflowRunId: ctx?.workflowRunId,
    workflowId: ctx?.workflowId,
    nodeId: ctx?.nodeId,
    nodeName: ctx?.nodeName,
  };
}

function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

export function buildCustomAgentTaskMessage(config: CustomAgentConfig): string {
  const {
    task,
    workflowRun,
    workflow,
    space,
    workspacePath,
    goal,
    relevantScopeLessons,
    previousTaskSummaries,
    nodeId,
    agentSlotName,
    coreMemories,
    relevantMemories,
  } = config;

  const sections: string[] = [];

  sections.push(`## Your Task #${task.taskNumber}`);
  sections.push('');
  sections.push(`**Title:** ${task.title}`);
  sections.push(`**Description:** ${labelVerificationImplementerFacing(task.description)}`);
  if (task.priority) sections.push(`**Priority:** ${task.priority}`);

  sections.push('');
  sections.push('## Runtime Location');
  sections.push('');
  sections.push(`- Worktree: ${workspacePath}`);

  if (goal) {
    sections.push('');
    sections.push('## Linked Goal');
    sections.push('');
    sections.push(`**Title:** ${goal.title}`);
    if (goal.description) sections.push(`**Description:** ${goal.description}`);
    sections.push(`**Status:** ${goal.status}`);
    sections.push(`**Type:** ${goal.type}`);
    sections.push(`**Priority:** ${goal.priority}`);
    if (goal.labels.length > 0) sections.push(`**Labels:** ${goal.labels.join(', ')}`);
    if (goal.type !== 'recurring') sections.push(`**Progress:** ${goal.progress}%`);
    if (goal.summary) sections.push(`**Current Summary:** ${goal.summary}`);
    if (Object.keys(goal.metrics).length > 0) {
      sections.push(`**Metrics:** ${JSON.stringify(goal.metrics)}`);
    }
    if (goal.nextSteps.length > 0) {
      sections.push('**Next Steps:**');
      for (const step of goal.nextSteps) sections.push(`- ${step}`);
    }
    sections.push(
      goal.type === 'recurring'
        ? 'When your work changes long-horizon state, update this goal via goal tools or mark_complete goal_update with a concise summary, metrics, and next steps.'
        : 'When your work changes long-horizon state, update this goal via goal tools or mark_complete goal_update with a concise summary, progress, metrics, and next steps.'
    );
  }

  if (relevantScopeLessons && relevantScopeLessons.length > 0) {
    sections.push('');
    sections.push('## Relevant Scope Lessons');
    sections.push('');
    for (const lesson of relevantScopeLessons) {
      const appliesTo = lesson.appliesTo.length > 0 ? ` [${lesson.appliesTo.join(', ')}]` : '';
      sections.push(`- ${lesson.rule}${appliesTo}`);
      if (lesson.why) sections.push(`  Why: ${lesson.why}`);
    }
  }

  const roleLines = buildRoleSection(workflow, nodeId, agentSlotName);
  if (roleLines.length > 0) {
    sections.push('');
    sections.push('## Your Role in This Workflow');
    sections.push('');
    sections.push(...roleLines);
  }

  const previousWorkLines = buildPreviousWorkLines(previousTaskSummaries);
  if (previousWorkLines.length > 0) {
    sections.push('');
    sections.push('## Previous Work on This Goal');
    sections.push('');
    sections.push(...previousWorkLines);
  }

  const coreMemoryLines = buildCoreMemoryLines(coreMemories);
  if (coreMemoryLines.length > 0) {
    sections.push('');
    sections.push('## Core Memories');
    sections.push('');
    sections.push(...coreMemoryLines);
  }

  if (relevantMemories && relevantMemories.length > 0) {
    sections.push('');
    sections.push('## Relevant Memories');
    sections.push('');
    for (const result of relevantMemories) {
      const tags = result.memory.tags.length > 0 ? ` [${result.memory.tags.join(', ')}]` : '';
      sections.push(
        `- ${result.memory.key}${tags}: ${truncateMemoryPromptContent(result.memory.content)}`
      );
    }
  }

  if (space.backgroundContext) {
    sections.push('');
    sections.push('## Project Context');
    sections.push('');
    sections.push(space.backgroundContext);
  }

  const standingLines: string[] = [];
  if (space.instructions?.trim()) standingLines.push(space.instructions.trim());
  if (workflow?.instructions?.trim()) standingLines.push(workflow.instructions.trim());
  if (standingLines.length > 0) {
    sections.push('');
    sections.push('## Standing Instructions');
    sections.push('');
    sections.push(standingLines.join('\n\n'));
  }

  const message = sections.join('\n');

  const byteLength = Buffer.byteLength(message, 'utf8');
  if (workflowRun && byteLength > USER_MESSAGE_SOFT_LIMIT_BYTES) {
    log.warn(
      `buildCustomAgentTaskMessage: user message is ${byteLength} bytes ` +
        `(soft limit ${USER_MESSAGE_SOFT_LIMIT_BYTES}). ` +
        `taskId=${task.id} workflowRunId=${workflowRun.id}${nodeId ? ` nodeId=${nodeId}` : ''}. ` +
        `Consider trimming space.backgroundContext or workflow.instructions.`
    );
  }

  return message;
}

function truncateMemoryPromptContent(content: string): string {
  if (content.length <= MEMORY_PROMPT_CONTENT_LIMIT) return content;
  return `${content.slice(0, MEMORY_PROMPT_CONTENT_LIMIT)}…`;
}

const IMPLEMENTER_FACING_VERIFICATION_LABEL =
  ' (for the implementer; the reviewer validates by reading, CI validates by running)';

export function labelVerificationImplementerFacing(description: string): string {
  return description.replace(
    /^[ \t]*(?:#{1,6}[ \t]*Verification[ \t]*|Verification:[ \t]*|\*\*Verification:\*\*[ \t]*)$/m,
    (heading) => `${heading.trimEnd()}${IMPLEMENTER_FACING_VERIFICATION_LABEL}`
  );
}

function buildPreviousWorkLines(items: string[] | undefined): string[] {
  if (!items || items.length === 0) return [];

  const lines = items.map((item) => `- ${item}`);
  const newestIndex = lines.length - 1;
  if (lines[newestIndex].length > OVERSIZED_NEWEST_PREVIOUS_WORK_LIMIT) {
    lines[newestIndex] = truncateBulletLine(
      lines[newestIndex],
      OVERSIZED_NEWEST_PREVIOUS_WORK_LIMIT
    );
  }
  return lines;
}

function truncateBulletLine(line: string, limit: number): string {
  if (line.length <= limit) return line;
  return `${line.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function buildCoreMemoryLines(coreMemories: AgentMemoryCoreEntry[] | undefined): string[] {
  if (!coreMemories || coreMemories.length === 0) return [];
  const lines: string[] = [];
  let used = 0;
  for (const memory of coreMemories) {
    const tags = memory.tags.length > 0 ? ` [${memory.tags.join(', ')}]` : '';
    const prefix = `- ${memory.key}${tags}: `;
    const remaining = CORE_MEMORY_PROMPT_CHAR_LIMIT - used - prefix.length;
    if (remaining <= 1) continue;
    const content =
      memory.content.length > remaining
        ? `${memory.content.slice(0, Math.max(0, remaining - 1))}…`
        : memory.content;
    const line = `${prefix}${content}`;
    lines.push(line);
    used += line.length + 1;
  }
  return lines;
}

function buildRoleSection(
  workflow: SpaceWorkflow | null | undefined,
  nodeId: string | undefined,
  _agentSlotName: string | undefined
): string[] {
  if (!workflow) return [];
  if (!workflow.nodes || workflow.nodes.length === 0) return [];

  const currentNode: WorkflowNode | undefined = nodeId
    ? workflow.nodes.find((n) => n.id === nodeId)
    : undefined;
  if (!currentNode) return [];

  const lines: string[] = [
    `- Workflow: ${workflow.name}${workflow.handle ? ` (handle: ${workflow.handle})` : ''}`,
  ];
  lines.push(`- Node: ${currentNode.name}`);

  const peers = workflow.nodes.filter((n) => n.id !== currentNode.id).map((n) => n.name);
  if (peers.length > 0) {
    lines.push(`- Peers: ${peers.join(', ')}`);
  }

  const outboundChannels = (workflow.channels ?? []).filter((ch) =>
    isChannelFromNode(ch, currentNode.name)
  );
  if (outboundChannels.length > 0) {
    lines.push(`- Channels from this node: ${outboundChannels.map(describeChannel).join('; ')}`);
  }

  const hookValidatedHandoffs = buildHookValidatedHandoffLines(workflow, currentNode);
  if (hookValidatedHandoffs.length > 0) {
    lines.push('- Outbound handoffs:');
    lines.push(...hookValidatedHandoffs);
  }

  return lines;
}

function buildHookValidatedHandoffLines(
  workflow: SpaceWorkflow,
  currentNode: WorkflowNode
): string[] {
  const PR_URL_HANDOFF_HOOK_VALIDATORS = new Set(['pr_ready', 'review_posted']);
  const outboundHookValidatedChannels = (workflow.channels ?? []).filter(
    (channel) =>
      isChannelFromNode(channel, currentNode.name) &&
      (workflow.hooks ?? []).some(
        (hook) =>
          hook.enabled !== false &&
          hook.method === 'send_message' &&
          hook.sourceNode === currentNode.name &&
          hook.targetNode === channel.to &&
          hook.validator?.kind === 'built_in' &&
          PR_URL_HANDOFF_HOOK_VALIDATORS.has(hook.validator.id)
      )
  );

  const lines: string[] = [];
  for (const channel of outboundHookValidatedChannels) {
    if (Array.isArray(channel.to)) continue;
    lines.push(
      `  - ${describeChannelTarget(channel, channel.to)}: call \`send_message(target=${JSON.stringify(channel.to)}, message="<short summary>", data: { "pr_url": "<pr_url>" })\`; \`save_artifact\` alone does not deliver this gated handoff.`
    );
  }
  return lines;
}

function isChannelFromNode(channel: WorkflowChannel, nodeName: string): boolean {
  if (channel.from === '*') return true;
  return channel.from === nodeName;
}

function describeChannel(channel: WorkflowChannel): string {
  const target = Array.isArray(channel.to) ? channel.to.join(', ') : channel.to;
  return channel.label ? `${target} (${channel.label})` : target;
}

function describeChannelTarget(channel: WorkflowChannel, target: string): string {
  if (!Array.isArray(channel.to) && channel.to !== '*') return describeChannel(channel);
  return channel.label ? `${target} (${channel.label})` : target;
}

export function createCustomAgentInit(config: CustomAgentConfig): AgentSessionInit {
  const { customAgent, task, space, sessionId, workspacePath, slotOverrides } = config;

  const customTools = customAgent.tools;
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
  const thinkingLevel = slotOverrides?.thinkingLevel ?? customAgent.thinkingLevel;
  const provider = slotOverrides?.model
    ? inferProviderForModel(model)
    : (customAgent.provider ?? inferProviderForModel(model));

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
  agentManager: SpaceAgentManager;
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
    agentManager,
    sessionId,
    workspacePath,
    workflowRun,
    workflow,
    previousTaskSummaries,
    slotOverrides,
    agentId,
  } = config;

  const agent = agentManager.getById(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId} (task: ${task.id})`);
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

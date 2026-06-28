/**
 * Worker Agent Factory
 *
 * Creates `AgentSessionInit` from a visible `SpaceWorkerAgent` + workflow slot configuration.
 * Runtime behavior must be WYSIWYG: code provides structure and context, while agent
 * behavior comes only from visible prompt fields on the agent or workflow node.
 */

import type { AgentSessionInit, PromptProvenanceInit } from '../../agent/agent-session';
import type {
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
} from '@neokai/shared';
import type { SkillEnablementOverride } from '@neokai/shared';
import type {
  AgentMemoryCoreEntry,
  AgentMemorySearchResult,
} from '../../../storage/repositories/agent-memory-repository';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import { inferProviderForModel } from '../../providers/registry';
import { Logger } from '../../logger';
import { SUB_SESSION_FEATURES } from './seed-agents';
import { deriveWorkerDisallowedTools } from './tool-policy';
import { formatGatedHandoffCall, getSendMessageTargets } from '../runtime/gated-handoff-guidance';

const DEFAULT_CUSTOM_AGENT_MODEL = 'claude-sonnet-4-6';

/**
 * Soft size budget for the initial user message. When exceeded, a warning is
 * logged so future prompt bloat is caught during development. Never fails.
 */
const USER_MESSAGE_SOFT_LIMIT_BYTES = 4 * 1024;
const MEMORY_PROMPT_CONTENT_LIMIT = 500;
const CORE_MEMORY_PROMPT_CHAR_LIMIT = 2_000;
const OVERSIZED_NEWEST_PREVIOUS_WORK_LIMIT = 2_000;

const log = new Logger('custom-agent');

/**
 * Per-slot overrides from a `WorkflowNodeAgent` entry.
 * Applied on top of the base `SpaceWorkerAgent` config when spawning a specific slot.
 *
 * Semantics:
 * - `customPrompt` is always appended (expanded) after the agent's `customPrompt`.
 *   It cannot replace the base prompt — the NeoKai contract sections remain intact.
 * - absent (undefined) — uses the agent's base value unchanged.
 */
export type PromptSource = 'workflow_node_custom_prompt' | 'space_agent_custom_prompt' | 'empty';

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
  /** Override the agent's default model for this slot */
  model?: string;
  /** Override the agent's default thinking level for this slot */
  thinkingLevel?: SpaceWorkerAgent['thinkingLevel'];
  /** Expansion text appended to the agent's customPrompt for this slot */
  customPrompt?: string;
  /** IDs of globally-enabled skills to disable for this slot */
  disabledSkillIds?: string[];
  /** Extra MCP servers to add for this slot */
  extraMcpServers?: Record<string, McpServerConfig>;
  /** Declarative tool guards from the workflow node agent definition */
  toolGuards?: DeclarativeToolGuard[];
  /** Runtime metadata used to make prompt provenance observable without prompt content. */
  resolutionContext?: SlotResolutionContext;
}

/**
 * Append-only prompt composition: returns `base` + `\n\n` + `expansion`.
 *
 * - If `expansion` is absent/empty, returns `base` unchanged.
 * - If `base` is absent/empty, returns `expansion`.
 * - Both present: joined with a double newline.
 */
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

/**
 * A snapshot of gate runtime data passed into `buildCustomAgentTaskMessage`.
 * The builder uses these records to derive runtime state such as the current
 * PR URL (any gate record with a `pr_url` string field is considered).
 */
export interface GateDataSnapshot {
  gateId: string;
  data: Record<string, unknown>;
  /** Unix epoch ms when this gate data was last updated. */
  updatedAt?: number;
}

export interface CustomAgentConfig {
  /** The Space agent definition */
  customAgent: SpaceWorkerAgent;
  /** The task being executed */
  task: SpaceTask;
  /** The workflow run context (null when running outside a workflow) */
  workflowRun: SpaceWorkflowRun | null;
  /** Full workflow definition for factual runtime context */
  workflow?: SpaceWorkflow | null;
  /** The Space this agent belongs to */
  space: Space;
  /** Session ID for the new session */
  sessionId: string;
  /** Workspace path (typically `space.workspacePath`) */
  workspacePath: string;
  /** Linked long-horizon goal for this task, when present. */
  goal?: SpaceGoal | null;
  /** Active scope lessons selected for this task, newest first. */
  relevantScopeLessons?: EvolutionLesson[];
  /** Summaries of previously completed tasks for context */
  previousTaskSummaries?: string[];
  /** Optional per-slot workflow overrides */
  slotOverrides?: SlotOverrides;
  /**
   * ID of the workflow node this session belongs to (required to scope the
   * "Your Role in This Workflow" section to the current node's peers,
   * channels, and gates). Omit when running outside a workflow.
   */
  nodeId?: string;
  /**
   * Agent slot name for the current node execution (`WorkflowNodeAgent.name`).
   * Used together with the node name to compute the set of gates the agent
   * can write to.
   */
  agentSlotName?: string;
  /**
   * Snapshot of gate data for the current workflow run. Used to derive
   * runtime state such as the current PR URL ("Runtime Location" section).
   * Absent when running outside a workflow or when no data has been written.
   */
  gateData?: GateDataSnapshot[];
  /** Space-scoped core memories selected by background consolidation. */
  coreMemories?: AgentMemoryCoreEntry[];
  /** Relevant persistent memories to inject into the task prompt. */
  relevantMemories?: AgentMemorySearchResult[];
}

/**
 * Build the runtime system prompt text for a worker agent.
 *
 * The NeoKai system contract (tool rules, completion semantics) is applied first by the
 * SDK preset; then the agent's `customPrompt` is appended, followed by any slot expansion.
 * User content always comes after the contract and cannot override it.
 */
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
  const value = expandPrompt(basePrompt, slotPrompt);
  const source: PromptSource = slotPrompt
    ? 'workflow_node_custom_prompt'
    : basePrompt
      ? 'space_agent_custom_prompt'
      : 'empty';
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
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(prompt);
  return hasher.digest('hex');
}

/**
 * Build the initial user message for a worker agent session.
 *
 * Contains factual task/workflow/space context only.
 * Behavioral prompt (persona, operating procedure) lives in the system prompt.
 *
 * Section order (top → bottom), action-first:
 *   1. `## Your Task` — title, description, priority
 *   2. `## Runtime Location` — worktree path, derived PR URL
 *   3. `## Relevant Scope Lessons` — accepted lessons from task scope
 *   4. `## Your Role in This Workflow` — current node, peers, outbound channels,
 *      writable gates (omitted outside a workflow)
 *   5. `## Previous Work on This Goal` — bulleted summaries
 *   6. `## Project Context` — space.backgroundContext
 *   7. `## Standing Instructions` — space.instructions + workflow.instructions
 *
 * Node UUIDs are intentionally dropped — they are not useful to the LLM and add
 * noise. The previous "Workflow Context" + "Workflow Structure" sections are
 * replaced by the scoped "Your Role" section.
 */
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
    gateData,
    coreMemories,
    relevantMemories,
  } = config;

  const sections: string[] = [];

  // 1. Task — actionable content first, so it lands in the first 500 chars.
  sections.push(`## Your Task #${task.taskNumber}`);
  sections.push('');
  sections.push(`**Title:** ${task.title}`);
  sections.push(`**Description:** ${task.description}`);
  if (task.priority) sections.push(`**Priority:** ${task.priority}`);

  // 2. Runtime Location — worktree is always known, PR URL derived from gate data.
  const prUrl = derivePrUrlFromGateData(gateData);
  sections.push('');
  sections.push('## Runtime Location');
  sections.push('');
  sections.push(`- Worktree: ${workspacePath}`);
  sections.push(`- PR: ${prUrl ?? 'none yet'}`);

  // 3. Linked Goal — rolling state for long-horizon work.
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

  // 4. Relevant scope lessons — accepted lessons from this task's evolution scope.
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

  // 5. Your Role in This Workflow — scoped to the current node when known.
  const roleLines = buildRoleSection(workflow, nodeId, agentSlotName);
  if (roleLines.length > 0) {
    sections.push('');
    sections.push('## Your Role in This Workflow');
    sections.push('');
    sections.push(...roleLines);
  }

  // 6. Previous work summaries.
  const previousWorkLines = buildPreviousWorkLines(previousTaskSummaries);
  if (previousWorkLines.length > 0) {
    sections.push('');
    sections.push('## Previous Work on This Goal');
    sections.push('');
    sections.push(...previousWorkLines);
  }

  // 7. Core memories are space-scoped and selected by background consolidation.
  const coreMemoryLines = buildCoreMemoryLines(coreMemories);
  if (coreMemoryLines.length > 0) {
    sections.push('');
    sections.push('## Core Memories');
    sections.push('');
    sections.push(...coreMemoryLines);
  }

  // 8. Relevant persistent memories.
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

  // 9. Project context from the Space.
  if (space.backgroundContext) {
    sections.push('');
    sections.push('## Project Context');
    sections.push('');
    sections.push(space.backgroundContext);
  }

  // 10. Standing instructions — space + workflow combined under one heading.
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

  // Soft budget: warn but never fail when the message exceeds the threshold.
  // `workflowRun` is used to scope the warning to workflow sessions (avoids
  // noise during short standalone tasks where large backgroundContext is
  // typically the cause and not a regression).
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

/**
 * Resolve a PR URL from a snapshot of gate data. The first gate record whose
 * data contains a non-empty `pr_url` string wins. Returns `undefined` when no
 * such field is present.
 */
function derivePrUrlFromGateData(gateData: GateDataSnapshot[] | undefined): string | undefined {
  if (!gateData || gateData.length === 0) return undefined;
  const sorted = [...gateData].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  for (const record of sorted) {
    const value = record.data?.pr_url;
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function truncateMemoryPromptContent(content: string): string {
  if (content.length <= MEMORY_PROMPT_CONTENT_LIMIT) return content;
  return `${content.slice(0, MEMORY_PROMPT_CONTENT_LIMIT)}…`;
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

/**
 * Build the bulleted "Your Role in This Workflow" lines scoped to the current
 * node. Returns `[]` when the workflow or current node cannot be resolved so
 * the caller can cleanly omit the section.
 */
function buildRoleSection(
  workflow: SpaceWorkflow | null | undefined,
  nodeId: string | undefined,
  agentSlotName: string | undefined
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

  const writableGates = (workflow.gates ?? []).filter((gate) =>
    isGateWritableFromNode(gate.fields, currentNode.name, agentSlotName)
  );
  if (writableGates.length > 0) {
    lines.push(
      `- Gates you can write: ${writableGates
        .map((g) => (g.label ? `${g.id} (${g.label})` : g.id))
        .join(', ')}`
    );
  }

  const gatedHandoffs = buildGatedHandoffLines(workflow, currentNode, agentSlotName);
  const hookValidatedHandoffs = buildHookValidatedHandoffLines(workflow, currentNode);
  const handoffLines = [...hookValidatedHandoffs, ...gatedHandoffs];
  if (handoffLines.length > 0) {
    lines.push('- Outbound gated handoffs:');
    lines.push(...handoffLines);
  }

  return lines;
}

function buildHookValidatedHandoffLines(
  workflow: SpaceWorkflow,
  currentNode: WorkflowNode
): string[] {
  const outboundHookValidatedChannels = (workflow.channels ?? []).filter(
    (channel) =>
      !channel.gateId &&
      isChannelFromNode(channel, currentNode.name) &&
      (workflow.hooks ?? []).some(
        (hook) =>
          hook.enabled !== false &&
          hook.method === 'send_message' &&
          hook.sourceNode === currentNode.name &&
          hook.targetNode === channel.to &&
          hook.validator?.kind === 'built_in' &&
          hook.validator.id === 'pr_ready'
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

function buildGatedHandoffLines(
  workflow: SpaceWorkflow,
  currentNode: WorkflowNode,
  agentSlotName: string | undefined
): string[] {
  const gateById = new Map((workflow.gates ?? []).map((gate) => [gate.id, gate]));
  const outboundGatedChannels = (workflow.channels ?? []).filter(
    (channel) => channel.gateId && isChannelFromNode(channel, currentNode.name)
  );
  const lines: string[] = [];

  for (const channel of outboundGatedChannels) {
    const gate = gateById.get(channel.gateId!);
    const writableFields = (gate?.fields ?? []).filter((field) =>
      isGateWritableFromNode([field], currentNode.name, agentSlotName)
    );
    if (writableFields.length === 0) continue;

    for (const target of getSendMessageTargets(
      channel.to,
      getBroadcastTargets(workflow, currentNode, agentSlotName)
    )) {
      lines.push(
        `  - ${describeChannelTarget(channel, target)}: call \`${formatGatedHandoffCall(target, writableFields)}\`; \`save_artifact\` alone does not deliver this gated handoff.`
      );
    }
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

function getBroadcastTargets(
  workflow: SpaceWorkflow,
  currentNode: WorkflowNode,
  agentSlotName: string | undefined
): string[] {
  const targets = new Set<string>();
  for (const node of workflow.nodes) {
    if (node.id !== currentNode.id) targets.add(node.name);
    for (const agent of node.agents ?? []) {
      if (node.id === currentNode.id && agent.name === agentSlotName) continue;
      targets.add(agent.name);
    }
  }
  targets.delete(currentNode.name);
  return [...targets];
}

function isGateWritableFromNode(
  fields: Array<{ writers: string[] }> | undefined,
  nodeName: string,
  agentSlotName: string | undefined
): boolean {
  if (!fields || fields.length === 0) return false;
  const candidates = [nodeName.toLowerCase()];
  if (agentSlotName) candidates.push(agentSlotName.toLowerCase());
  return fields.some((field) => {
    return field.writers.some((writer) => {
      const w = writer.toLowerCase();
      return w === '*' || candidates.includes(w);
    });
  });
}

/**
 * Create an `AgentSessionInit` for a Space agent session.
 *
 * Workflow execution is WYSIWYG:
 * - inside a workflow run, the workflow slot customPrompt is expanded on top of the agent's
 * - outside a workflow run, the agent's own `customPrompt` is used unchanged
 *
 * The NeoKai system contract (preset) is always applied first; user content follows.
 */
export function createCustomAgentInit(config: CustomAgentConfig): AgentSessionInit {
  const { customAgent, task, space, sessionId, workspacePath, slotOverrides } = config;

  const customTools = customAgent.tools;
  const customDisallowedBuiltins = deriveWorkerDisallowedTools(customTools);
  const customAgentInvocationTools = customTools?.filter((tool) =>
    ['Task', 'TaskOutput', 'TaskStop'].includes(tool)
  );
  const customToolPermissions = {
    ...(customAgentInvocationTools?.length ? { allowedTools: customAgentInvocationTools } : {}),
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
    skillOverrides,
    mcpServers: extraMcpServers,
    settingSources: customAgent.settingSources ?? space.settingSources,
    toolGuards,
  };
}

export interface ResolveAgentInitConfig {
  /** The task to execute */
  task: SpaceTask;
  /** The Space this task belongs to */
  space: Space;
  /** Agent manager for resolving agents */
  agentManager: SpaceAgentManager;
  /** Session ID for the new session */
  sessionId: string;
  /** Workspace path */
  workspacePath: string;
  /** Workflow run context (null when outside a workflow) */
  workflowRun?: SpaceWorkflowRun | null;
  /** Full workflow definition for factual runtime context */
  workflow?: SpaceWorkflow | null;
  /** Summaries of previously completed tasks */
  previousTaskSummaries?: string[];
  /** Optional per-slot workflow overrides */
  slotOverrides?: SlotOverrides;
  /**
   * Explicit agent ID to use for this session.
   * Required since SpaceTask no longer stores customAgentId directly.
   */
  agentId: string;
}

/**
 * Resolve the session init for a Space task by loading its assigned `SpaceWorkerAgent`.
 */
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

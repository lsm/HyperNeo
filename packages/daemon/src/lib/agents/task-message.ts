import type { WorkflowChannel, WorkflowNode, SpaceWorkflow } from '@hyperneo/shared';
import type { AgentMemoryCoreEntry } from '../../storage/repositories/agent-memory-repository.ts';
import { Logger } from '../logger.ts';
import type { CustomAgentConfig, TaskMessageContext } from './custom-agent-types.ts';

const USER_MESSAGE_SOFT_LIMIT_BYTES = 4 * 1024;
const MEMORY_PROMPT_CONTENT_LIMIT = 500;
const CORE_MEMORY_PROMPT_CHAR_LIMIT = 2_000;
const OVERSIZED_NEWEST_PREVIOUS_WORK_LIMIT = 2_000;

const log = new Logger('custom-agent');

export function buildCustomAgentTaskMessage(
  config: TaskMessageContext | CustomAgentConfig
): string {
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
    reviewFeedback,
  } = config;

  const sections: string[] = [];

  sections.push(`## Your Task #${task.taskNumber}`);
  sections.push('');
  sections.push(`**Title:** ${task.title}`);
  sections.push(`**Description:** ${labelVerificationImplementerFacing(task.description)}`);
  if (task.priority) sections.push(`**Priority:** ${task.priority}`);
  if (reviewFeedback != null) {
    sections.push('', '## Requested Revisions', '', reviewFeedback);
  }

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
      'When this task finishes, record a concise outcome summary in its result. The goal owner reviews reported outcomes and applies goal updates — do not mutate the goal rolling state yourself.'
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

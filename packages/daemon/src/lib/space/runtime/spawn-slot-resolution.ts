import { resolveNodeAgents } from '@hyperneo/shared';
import type {
  McpServerConfig,
  SpaceTask,
  SpaceWorkflow,
  WorkflowNode,
  WorkflowNodeAgent,
} from '@hyperneo/shared';
import type { AgentSessionInit } from '../../agent/agent-session';
import type { SlotOverrides } from '../agents/custom-agent';

export interface WorkflowNodeSlotResolution {
  node: WorkflowNode;
  slot: WorkflowNodeAgent;
}

export function resolveWorkflowNodeSlot(
  workflow: SpaceWorkflow | null | undefined,
  workflowNodeId: string,
  agentName: string
): WorkflowNodeSlotResolution | null {
  const node = workflow?.nodes.find((candidate) => candidate.id === workflowNodeId);
  if (!node) return null;

  let nodeAgents: ReturnType<typeof resolveNodeAgents>;
  try {
    nodeAgents = resolveNodeAgents(node);
  } catch {
    return null;
  }

  const slot =
    nodeAgents.length === 1
      ? nodeAgents[0]
      : nodeAgents.find((agentSlot) => agentSlot.name === agentName);
  return slot?.agentId ? { node, slot } : null;
}

export interface BuildSlotOverridesContext {
  task?: Pick<SpaceTask, 'workflowModelOverrides'>;
  node?: { id: string; name: string };
  workflow?: { id: string };
  workflowRun?: { id: string };
}

export function buildSlotOverrides(
  slot: WorkflowNodeAgent,
  context?: BuildSlotOverridesContext
): SlotOverrides {
  let slotCustomPrompt: string | undefined = slot.customPrompt?.value;
  if (!slotCustomPrompt && slot.replaceAgentPrompt !== true) {
    const legacySlot = slot as {
      systemPrompt?: { value: string };
      instructions?: { value: string };
    };
    const legacySp = legacySlot.systemPrompt?.value?.trim() ?? '';
    const legacyInstr = legacySlot.instructions?.value?.trim() ?? '';
    if (legacySp && legacyInstr) {
      slotCustomPrompt = `${legacySp}\n\n${legacyInstr}`;
    } else {
      slotCustomPrompt = legacySp || legacyInstr || undefined;
    }
  }
  const modelOverrideKey = context?.node ? `${context.node.id}:${slot.name}` : null;
  const taskModelOverride = modelOverrideKey
    ? context?.task?.workflowModelOverrides?.[modelOverrideKey]
    : undefined;
  const effectiveGuards = slot.toolGuards;
  return {
    model: taskModelOverride ?? slot.model,
    thinkingLevel: slot.thinkingLevel,
    customPrompt: slotCustomPrompt,
    replaceAgentPrompt: slot.replaceAgentPrompt,
    disabledSkillIds: slot.disabledSkillIds,
    extraMcpServers: slot.extraMcpServers,
    toolGuards: effectiveGuards,
    resolutionContext: {
      agentId: slot.agentId,
      agentName: slot.name,
      workflowRunId: context?.workflowRun?.id,
      workflowId: context?.workflow?.id,
      nodeId: context?.node?.id,
      nodeName: context?.node?.name,
    },
  };
}

export function buildExecutionBaseSessionId(
  spaceId: string,
  taskId: string,
  executionId: string
): string {
  return `space:${spaceId}:task:${taskId}:exec:${executionId}`;
}

export function findAvailableSessionId(
  baseId: string,
  isTaken: (sessionId: string) => boolean
): string {
  if (!isTaken(baseId)) return baseId;

  const MAX_ATTEMPTS = 100;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const candidateId = `${baseId}:${attempt}`;
    if (!isTaken(candidateId)) return candidateId;
  }
  throw new Error(
    `Could not find available session ID for base "${baseId}" after ${MAX_ATTEMPTS} attempts`
  );
}

export interface SpawnWorkspaceResolution {
  workspacePath: string;
  createWorktree: boolean;
}

export function resolveSpawnWorkspace(input: {
  cachedTaskWorktreePath: string | undefined;
  hasWorktreeManager: boolean;
  spaceWorkspacePath: string;
}): SpawnWorkspaceResolution {
  return {
    workspacePath: input.cachedTaskWorktreePath ?? input.spaceWorkspacePath,
    createWorktree: input.cachedTaskWorktreePath === undefined && input.hasWorktreeManager,
  };
}

export function assembleNodeAgentSessionInit(input: {
  baseInit: AgentSessionInit;
  title: string;
  nodeAgentMcpServer: McpServerConfig;
  agentMemoryMcpServers: Record<string, McpServerConfig>;
}): AgentSessionInit {
  return {
    ...input.baseInit,
    title: input.title,
    mcpServers: {
      ...input.baseInit.mcpServers,
      'node-agent': input.nodeAgentMcpServer,
      ...input.agentMemoryMcpServers,
    },
  };
}

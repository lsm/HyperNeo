import type { SpaceWorkflow, WorkflowChannel, WorkflowNode } from '@hyperneo/shared';
import { isChannelCyclic, resolveNodeAgents } from '@hyperneo/shared';
import { POST_APPROVAL_TASK_AGENT_TARGET } from '../space/workflows/post-approval-validator.ts';

export function findNodeByAgentName(
  workflow: SpaceWorkflow,
  role: string
): WorkflowNode | undefined {
  for (const node of workflow.nodes) {
    try {
      const agents = resolveNodeAgents(node);
      if (agents.some((a) => a.name === role)) return node;
    } catch {}
  }
  return undefined;
}

export function findMatchingWorkflowChannel(
  workflow: SpaceWorkflow,
  fromRole: string,
  toTarget: string
): { channel: WorkflowChannel; index: number } | undefined {
  const fromNodeName = findNodeByAgentName(workflow, fromRole)?.name;
  const toNodeName =
    findNodeByAgentName(workflow, toTarget)?.name ??
    workflow.nodes.find((node) => node.name === toTarget)?.name;
  const channels = workflow.channels ?? [];
  const index = channels.findIndex((ch) => {
    if (ch.from !== '*' && ch.from !== fromRole && ch.from !== fromNodeName) return false;
    if (ch.to === '*' || ch.to === toTarget || (!!toNodeName && ch.to === toNodeName)) return true;
    if (Array.isArray(ch.to)) {
      return ch.to.includes(toTarget) || (!!toNodeName && ch.to.includes(toNodeName));
    }
    return false;
  });
  return index >= 0 ? { channel: channels[index], index } : undefined;
}

export function isChannelCyclicByIndex(channelIndex: number, workflow: SpaceWorkflow): boolean {
  const channels = workflow.channels ?? [];
  return isChannelCyclic(channelIndex, channels, workflow.nodes);
}

export function getPostApprovalTargetAgents(workflow: SpaceWorkflow): Set<string> {
  const agents = new Set<string>();
  for (const node of workflow.nodes) {
    const targetAgent = node.postApproval?.targetAgent;
    if (targetAgent && targetAgent !== POST_APPROVAL_TASK_AGENT_TARGET) agents.add(targetAgent);
  }
  const legacy = workflow.postApproval?.targetAgent;
  if (legacy && legacy !== POST_APPROVAL_TASK_AGENT_TARGET) agents.add(legacy);
  return agents;
}

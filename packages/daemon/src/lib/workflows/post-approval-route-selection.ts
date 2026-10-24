import { POST_APPROVAL_COMPLETION_INSTRUCTIONS } from '@hyperneo/prompts';
import type { PostApprovalRoute, SpaceWorkflow } from '@hyperneo/shared';
import { resolveNodeAgents } from '@hyperneo/shared';
import { builtInWorkflowRequiresPrMerge } from './built-in-workflows.ts';
import { POST_APPROVAL_TASK_AGENT_TARGET } from './post-approval-validator.ts';

export function appendPostApprovalCompletionInstructions(interpolatedInstructions: string): string {
  const trimmed = interpolatedInstructions.trim();
  return `${trimmed}\n\n${POST_APPROVAL_COMPLETION_INSTRUCTIONS}`;
}

export function collectPostApprovalRoutes(workflow: SpaceWorkflow | null): PostApprovalRoute[] {
  if (!workflow) return [];
  const nodeRoutes = workflow.nodes
    .map((node) => node.postApproval)
    .filter((route): route is PostApprovalRoute => !!route);
  if (nodeRoutes.length > 0) return nodeRoutes;
  return workflow.postApproval ? [workflow.postApproval] : [];
}

export function collectDispatchablePostApprovalRoutes(
  workflow: SpaceWorkflow | null
): PostApprovalRoute[] {
  return collectPostApprovalRoutes(workflow).filter(
    (route) => route.targetAgent && route.targetAgent !== POST_APPROVAL_TASK_AGENT_TARGET
  );
}

export function isCoderOwnedMergeWorkflow(workflow: SpaceWorkflow | null): boolean {
  return (
    collectDispatchablePostApprovalRoutes(workflow)[0]?.requirePrMerge === true ||
    builtInWorkflowRequiresPrMerge(workflow?.templateName)
  );
}

export function selectFirstDispatchablePostApprovalRoute(
  workflow: SpaceWorkflow | null
): { route: PostApprovalRoute; nodeId: string | null; agentName: string } | null {
  if (!workflow) return null;
  let selected: PostApprovalRoute | null = null;
  let declaredByNodeId: string | null = null;
  for (const node of workflow.nodes) {
    const route = node.postApproval;
    if (route?.targetAgent && route.targetAgent !== POST_APPROVAL_TASK_AGENT_TARGET) {
      selected = route;
      declaredByNodeId = node.id;
      break;
    }
  }
  if (!selected) {
    const legacy = workflow.postApproval;
    if (legacy?.targetAgent && legacy.targetAgent !== POST_APPROVAL_TASK_AGENT_TARGET) {
      selected = legacy;
    }
  }
  if (!selected) return null;
  const targetAgent = selected.targetAgent;
  for (const node of workflow.nodes) {
    let owningSlot: { name?: string; agentId?: string } | null = null;
    try {
      owningSlot =
        resolveNodeAgents(node).find(
          (agent) => agent.name === targetAgent || agent.agentId === targetAgent
        ) ?? null;
    } catch {
      continue;
    }
    if (owningSlot) {
      return { route: selected, nodeId: node.id, agentName: owningSlot.name ?? targetAgent };
    }
  }
  return { route: selected, nodeId: declaredByNodeId, agentName: targetAgent };
}

export const clearedPendingCompletion = {
  pendingCheckpointType: null,
  pendingCompletionSubmittedByNodeId: null,
  pendingCompletionSubmittedAt: null,
  pendingCompletionReason: null,
} as const;

export function mapPostApprovalDispatchWarning(detail: string): string {
  const trimmed = (detail ?? '').trim();
  const lower = trimmed.toLowerCase();
  const interrupted =
    lower.includes('interrupted') || lower.includes('abort') || lower.includes('cancel');
  const cause = interrupted
    ? `post-approval dispatch was interrupted (${trimmed})`
    : `post-approval dispatch hit an error: ${trimmed}`;
  return `Approval recorded, but ${cause}. The task is approved; you may need to manually trigger post-approval work.`;
}

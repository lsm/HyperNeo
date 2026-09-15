import type { NodeExecutionStatus, WorkflowNode } from '@hyperneo/shared';
import { resolveNodeAgents } from '@hyperneo/shared';

export interface ActivationExistingExecutionFacts {
  status: NodeExecutionStatus;
  agentSessionId: string | null;
  sessionAlive: boolean;
}

export interface ActivationRoutingInput {
  existingExecution?: ActivationExistingExecutionFacts | null;
  workflowNodeId?: string;
  agentDeclaredOnNode?: boolean;
  taskRunWorkflowResolvable?: boolean;
  executionResolvable?: boolean;
}

export type ActivationRoutingDecision =
  | { action: 'reuse_existing'; sessionId: string }
  | { action: 'reset_pending_and_continue' }
  | { action: 'reject_undeclared' }
  | { action: 'spawn_with_timeout' }
  | { action: 'return_empty' };

export function decideActivationRouting(input: ActivationRoutingInput): ActivationRoutingDecision {
  const existing = input.existingExecution ?? null;
  if (existing && (existing.status === 'in_progress' || existing.status === 'blocked')) {
    if (existing.agentSessionId && existing.sessionAlive) {
      return { action: 'reuse_existing', sessionId: existing.agentSessionId };
    }
    return { action: 'reset_pending_and_continue' };
  }
  if (input.workflowNodeId !== undefined && input.agentDeclaredOnNode === false) {
    return { action: 'reject_undeclared' };
  }
  if (input.taskRunWorkflowResolvable === false) {
    return { action: 'return_empty' };
  }
  if (input.executionResolvable === false) {
    return { action: 'return_empty' };
  }
  return { action: 'spawn_with_timeout' };
}

export function selectWorkflowNodeForAgent(
  nodes: readonly WorkflowNode[],
  agentName: string,
  workflowNodeId?: string
): WorkflowNode | null {
  for (const node of nodes) {
    let slots: ReturnType<typeof resolveNodeAgents>;
    try {
      slots = resolveNodeAgents(node);
    } catch {
      continue;
    }
    if (!slots.some((slot) => slot.name === agentName)) continue;
    if (workflowNodeId && node.id !== workflowNodeId) continue;
    return node;
  }
  return null;
}

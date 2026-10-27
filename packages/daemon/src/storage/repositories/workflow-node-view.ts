import type { WorkflowNode, WorkflowNodeAgent } from '@hyperneo/shared';
import type { WorkflowNodeConfig } from './workflow-node-config.ts';

export function buildWorkflowNodeView(
  row: Pick<WorkflowNode, 'id' | 'name'>,
  cfg: WorkflowNodeConfig
): WorkflowNode {
  const agents: WorkflowNodeAgent[] =
    cfg.agents && cfg.agents.length > 0
      ? cfg.agents.map((a: WorkflowNodeAgent) => ({
          ...a,
          name: a.name?.trim() ? a.name : a.agentId,
        }))
      : [];

  return {
    id: row.id,
    name: row.name,
    agents,
    ...(cfg.postApproval ? { postApproval: cfg.postApproval } : {}),
    ...(cfg.transitions && cfg.transitions.length > 0 ? { transitions: cfg.transitions } : {}),
  };
}

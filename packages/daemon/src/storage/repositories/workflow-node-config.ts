import type {
  HandoffTransition,
  PostApprovalRoute,
  WorkflowNodeAgent,
  WorkflowNodeInput,
} from '@hyperneo/shared';

export interface WorkflowNodeConfig {
  agents?: WorkflowNodeAgent[];
  postApproval?: PostApprovalRoute;
  transitions?: HandoffTransition[];
}

export function buildWorkflowNodeConfig(input: WorkflowNodeInput): WorkflowNodeConfig {
  const nodeCfg: WorkflowNodeConfig = {};

  const legacyAgentId = (input as unknown as Record<string, unknown>)['agentId'] as
    | string
    | undefined;
  let resolvedAgents = input.agents && input.agents.length > 0 ? input.agents : undefined;
  if (!resolvedAgents && legacyAgentId) {
    resolvedAgents = [{ agentId: legacyAgentId, name: input.name }];
  }
  if (resolvedAgents && resolvedAgents.length > 0) {
    nodeCfg.agents = resolvedAgents;
  }
  if (input.postApproval) {
    nodeCfg.postApproval = input.postApproval;
  }
  if (input.transitions && input.transitions.length > 0) {
    nodeCfg.transitions = input.transitions;
  }

  return nodeCfg;
}

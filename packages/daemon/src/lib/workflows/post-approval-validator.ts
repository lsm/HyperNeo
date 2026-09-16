import type { PostApprovalRoute, WorkflowNode, WorkflowNodeInput } from '@hyperneo/shared';

export const POST_APPROVAL_TASK_AGENT_TARGET = 'task-agent';

export interface PostApprovalValidationInput {
  postApproval?: PostApprovalRoute;
  nodes: Array<WorkflowNode | WorkflowNodeInput>;
}

export interface PostApprovalRoutesValidationInput {
  workflowPostApproval?: PostApprovalRoute;
  nodes: Array<WorkflowNode | WorkflowNodeInput>;
}

export type PostApprovalValidationResult =
  | { ok: true }
  | { ok: false; error: string; eligibleTargets: string[] };

export function collectEligiblePostApprovalTargets(
  nodes: Array<WorkflowNode | WorkflowNodeInput>
): string[] {
  const targets: string[] = [POST_APPROVAL_TASK_AGENT_TARGET];
  const seen = new Set<string>(targets);
  for (const node of nodes) {
    const agents = node.agents ?? [];
    for (const agent of agents) {
      const name = typeof agent?.name === 'string' ? agent.name.trim() : '';
      if (!name || seen.has(name)) continue;
      seen.add(name);
      targets.push(name);
    }
  }
  return targets;
}

export function validatePostApproval(
  input: PostApprovalValidationInput
): PostApprovalValidationResult {
  const route = input.postApproval;
  if (!route) {
    return { ok: true };
  }

  const targetAgent = typeof route.targetAgent === 'string' ? route.targetAgent.trim() : '';
  const eligible = collectEligiblePostApprovalTargets(input.nodes);

  if (!targetAgent) {
    return {
      ok: false,
      error:
        `postApproval.targetAgent must be a non-empty string; ` +
        `eligible targets: ${eligible.map((t) => `"${t}"`).join(', ')}`,
      eligibleTargets: eligible,
    };
  }

  if (eligible.includes(targetAgent)) {
    return { ok: true };
  }

  return {
    ok: false,
    error:
      `postApproval.targetAgent "${targetAgent}" does not match any node agent or the ` +
      `orchestration Task Agent; eligible targets: ${eligible.map((t) => `"${t}"`).join(', ')}`,
    eligibleTargets: eligible,
  };
}

export function validatePostApprovalRoutes(
  input: PostApprovalRoutesValidationInput
): PostApprovalValidationResult {
  const workflowResult = validatePostApproval({
    postApproval: input.workflowPostApproval,
    nodes: input.nodes,
  });
  if (!workflowResult.ok) return workflowResult;

  for (const node of input.nodes) {
    const route = node.postApproval;
    if (!route) continue;
    const result = validatePostApproval({ postApproval: route, nodes: input.nodes });
    if (!result.ok) {
      return {
        ...result,
        error: `node "${node.name}" ${result.error}`,
      };
    }
  }

  return { ok: true };
}

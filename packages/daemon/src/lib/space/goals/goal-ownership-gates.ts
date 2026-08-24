import type { SpaceMcpSessionRole } from '../runtime/space-mcp-session-policy.ts';

export type GoalOwnershipAdmissionDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: 'not_coordinator_or_human'; message: string };

export interface GoalOwnershipAdmissionInput {
  callerRole: SpaceMcpSessionRole | undefined;
  hasSession: boolean;
}

export function decideGoalOwnershipMutationAdmission(
  input: GoalOwnershipAdmissionInput
): GoalOwnershipAdmissionDecision {
  if (!input.hasSession) return { action: 'allow' };
  if (input.callerRole === 'coordinator') return { action: 'allow' };
  return {
    action: 'deny',
    reason: 'not_coordinator_or_human',
    message:
      'assign_agent_to_goal/unassign_agent_from_goal owner mutations require coordinator or explicit human authorization. Request human approval or use the coordinator agent.',
  };
}

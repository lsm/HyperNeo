export type GoalOwnershipAdmissionDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: 'not_space_agent_or_human'; message: string };

export interface GoalOwnershipAdmissionInput {
  hasSpaceAuthority: boolean;
  hasSession: boolean;
}

export function decideGoalOwnershipMutationAdmission(
  input: GoalOwnershipAdmissionInput
): GoalOwnershipAdmissionDecision {
  if (!input.hasSession) return { action: 'allow' };
  if (input.hasSpaceAuthority) return { action: 'allow' };
  return {
    action: 'deny',
    reason: 'not_space_agent_or_human',
    message:
      'assign_agent_to_goal/unassign_agent_from_goal owner mutations require a Space agent session or explicit human authorization.',
  };
}

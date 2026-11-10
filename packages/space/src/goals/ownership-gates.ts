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
    message: 'goal.owner.set requires a Space agent session or explicit human authorization.',
  };
}

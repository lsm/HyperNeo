import superpipe, { type PipelineAPI } from 'superpipe';

export type GoalOwnerAgentState =
  | { state: 'active' }
  | { state: 'missing' }
  | { state: 'paused' }
  | { state: 'disabled' }
  | { state: 'archived' };

export interface GoalOwnerCandidate {
  agentId: string;
  relationship: 'owner' | 'manager' | 'watcher';
  createdAt: number;
}

export type GoalOwnerResolutionDecision =
  | { action: 'resolved'; owner: GoalOwnerCandidate; conflicts: GoalOwnerCandidate[] }
  | {
      action: 'degraded';
      reason: GoalOwnerAgentState['state'];
      owner: GoalOwnerCandidate;
      conflicts: GoalOwnerCandidate[];
    }
  | { action: 'no_recipient' };

export interface GoalOwnerResolutionInput {
  candidates: GoalOwnerCandidate[];
  agentStates: Record<string, GoalOwnerAgentState>;
}

export interface GoalOwnerScope {
  owners: GoalOwnerCandidate[];
  primary: GoalOwnerCandidate | null;
  conflicts: GoalOwnerCandidate[];
  primaryState: GoalOwnerAgentState;
}

export function orderOwnerCandidates(candidates: GoalOwnerCandidate[]): GoalOwnerCandidate[] {
  return candidates
    .filter((candidate) => candidate.relationship === 'owner')
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.agentId.localeCompare(b.agentId));
}

export function resolveOwnerScope(input: GoalOwnerResolutionInput): GoalOwnerScope {
  const owners = orderOwnerCandidates(input.candidates);
  const primary = owners[0] ?? null;
  return {
    owners,
    primary,
    conflicts: owners.slice(1),
    primaryState: primary
      ? (input.agentStates[primary.agentId] ?? { state: 'missing' })
      : { state: 'missing' },
  };
}

export function classifyGoalOwnerResolution(scope: GoalOwnerScope): GoalOwnerResolutionDecision {
  if (scope.primary === null) return { action: 'no_recipient' };
  if (scope.primaryState.state === 'active') {
    return { action: 'resolved', owner: scope.primary, conflicts: scope.conflicts };
  }
  return {
    action: 'degraded',
    reason: scope.primaryState.state,
    owner: scope.primary,
    conflicts: scope.conflicts,
  };
}

export const decideGoalOwnerResolution = (superpipe({})('goal-owner-resolution') as PipelineAPI)
  .input(['input'])
  .pipe(resolveOwnerScope, 'input', 'scope')
  .pipe(classifyGoalOwnerResolution, 'scope', 'decision')
  .end('decision') as (input: GoalOwnerResolutionInput) => GoalOwnerResolutionDecision;

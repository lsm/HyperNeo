import { decisionRun } from '../runtime/decision-pipeline.ts';

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
  | { action: 'coordinator_fallback'; coordinatorAgentId: string }
  | { action: 'no_recipient' };

export interface GoalOwnerResolutionCtx {
  candidates: GoalOwnerCandidate[];
  agentStates: Record<string, GoalOwnerAgentState>;
  coordinatorAgentId: string | null;
  decision: GoalOwnerResolutionDecision | null;
}

export type GoalOwnerResolutionInput = Omit<GoalOwnerResolutionCtx, 'decision'>;

function decided(
  ctx: GoalOwnerResolutionCtx,
  decision: GoalOwnerResolutionDecision
): GoalOwnerResolutionCtx {
  return { ...ctx, decision };
}

function ownerCandidates(candidates: GoalOwnerCandidate[]): GoalOwnerCandidate[] {
  return candidates
    .filter((c) => c.relationship === 'owner')
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.agentId.localeCompare(b.agentId));
}

function agentState(ctx: GoalOwnerResolutionCtx, agentId: string): GoalOwnerAgentState {
  return ctx.agentStates[agentId] ?? { state: 'missing' };
}

export function applyResolvedOwnerGate(ctx: GoalOwnerResolutionCtx): GoalOwnerResolutionCtx {
  const owners = ownerCandidates(ctx.candidates);
  if (owners.length < 1) return ctx;
  const primary = owners[0];
  const agent = agentState(ctx, primary.agentId);
  if (agent.state !== 'active') return ctx;
  return decided(ctx, { action: 'resolved', owner: primary, conflicts: owners.slice(1) });
}

export function applyDegradedOwnerGate(ctx: GoalOwnerResolutionCtx): GoalOwnerResolutionCtx {
  const owners = ownerCandidates(ctx.candidates);
  if (owners.length < 1) return ctx;
  const primary = owners[0];
  const agent = agentState(ctx, primary.agentId);
  if (agent.state === 'active') return ctx;
  return decided(ctx, {
    action: 'degraded',
    reason: agent.state,
    owner: primary,
    conflicts: owners.slice(1),
  });
}

export function applyCoordinatorFallbackGate(ctx: GoalOwnerResolutionCtx): GoalOwnerResolutionCtx {
  const owners = ownerCandidates(ctx.candidates);
  if (owners.length >= 1) return ctx;
  if (ctx.coordinatorAgentId === null) return decided(ctx, { action: 'no_recipient' });
  return decided(ctx, {
    action: 'coordinator_fallback',
    coordinatorAgentId: ctx.coordinatorAgentId,
  });
}

const ownerResolutionRun = decisionRun('goal-owner-resolution', [
  applyResolvedOwnerGate,
  applyDegradedOwnerGate,
  applyCoordinatorFallbackGate,
]);

export function decideGoalOwnerResolution(
  input: GoalOwnerResolutionInput
): GoalOwnerResolutionDecision {
  const ctx = ownerResolutionRun(input);
  return ctx.decision ?? { action: 'no_recipient' };
}

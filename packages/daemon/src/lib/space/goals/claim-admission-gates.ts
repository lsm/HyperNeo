import { decisionRun } from '../runtime/decision-pipeline';
import type { SpaceGoalOutcomeNotificationStatus } from '@hyperneo/shared';

export type ClaimAdmissionDenyReason =
  | 'unauthorized'
  | 'superseded'
  | 'identity_mismatch'
  | 'stale_revision';

export type ClaimAdmissionDecision =
  | { action: 'admit' }
  | { action: 'deny'; reason: ClaimAdmissionDenyReason };

export interface ClaimAdmissionCtx {
  actorAgentId: string | null;
  authorizedAgentIds: string[];
  humanAdmissionAllowed: boolean;
  notificationStatus: SpaceGoalOutcomeNotificationStatus;
  notificationGoalId: string;
  notificationTaskId: string;
  notificationGoalRevision: number;
  claimedGoalId: string;
  claimedTaskId: string;
  mutatesGoalState: boolean;
  observedGoalRevision: number | null;
  currentGoalRevision: number;
  decision: ClaimAdmissionDecision | null;
}

export type ClaimAdmissionInput = Omit<ClaimAdmissionCtx, 'decision'>;

function decided(ctx: ClaimAdmissionCtx, decision: ClaimAdmissionDecision): ClaimAdmissionCtx {
  return { ...ctx, decision };
}

function isAuthorizedActor(ctx: ClaimAdmissionCtx): boolean {
  if (ctx.actorAgentId === null) return ctx.humanAdmissionAllowed;
  return ctx.authorizedAgentIds.includes(ctx.actorAgentId);
}

export function applyAuthorizedGate(ctx: ClaimAdmissionCtx): ClaimAdmissionCtx {
  return isAuthorizedActor(ctx) ? ctx : decided(ctx, { action: 'deny', reason: 'unauthorized' });
}

export function applyUnsupersededGate(ctx: ClaimAdmissionCtx): ClaimAdmissionCtx {
  return ctx.notificationStatus === 'pending'
    ? ctx
    : decided(ctx, { action: 'deny', reason: 'superseded' });
}

export function applyIdentityBoundGate(ctx: ClaimAdmissionCtx): ClaimAdmissionCtx {
  const taskMatches = ctx.claimedTaskId === ctx.notificationTaskId;
  const goalMatches = ctx.claimedGoalId === ctx.notificationGoalId;
  return goalMatches && taskMatches
    ? ctx
    : decided(ctx, { action: 'deny', reason: 'identity_mismatch' });
}

export function applyRevisionMatchGate(ctx: ClaimAdmissionCtx): ClaimAdmissionCtx {
  if (!ctx.mutatesGoalState) return ctx;
  const baseRevision = ctx.observedGoalRevision ?? ctx.notificationGoalRevision;
  return baseRevision === ctx.currentGoalRevision
    ? ctx
    : decided(ctx, { action: 'deny', reason: 'stale_revision' });
}

export function applyAdmitGate(ctx: ClaimAdmissionCtx): ClaimAdmissionCtx {
  return decided(ctx, { action: 'admit' });
}

const claimAdmissionRun = decisionRun('claim-admission', [
  applyAuthorizedGate,
  applyUnsupersededGate,
  applyIdentityBoundGate,
  applyRevisionMatchGate,
  applyAdmitGate,
]);

export function decideClaimAdmission(input: ClaimAdmissionInput): ClaimAdmissionDecision {
  const ctx = claimAdmissionRun(input);
  return ctx.decision ?? { action: 'deny', reason: 'unauthorized' };
}

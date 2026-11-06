import type { SpaceGoalOutcomeNotificationStatus } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

export type ClaimAdmissionDenyReason =
  | 'unauthorized'
  | 'superseded'
  | 'identity_mismatch'
  | 'stale_revision';

export type ClaimAdmissionDecision =
  | { action: 'admit' }
  | { action: 'deny'; reason: ClaimAdmissionDenyReason };

export interface ClaimAdmissionInput {
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
  isResubmission: boolean;
  observedGoalRevision: number | null;
  currentGoalRevision: number;
}

export type ClaimAdmissionReason = ClaimAdmissionDenyReason;

export function isAuthorizedActor(input: ClaimAdmissionInput): boolean {
  if (input.actorAgentId === null) return input.humanAdmissionAllowed;
  return input.authorizedAgentIds.includes(input.actorAgentId);
}

export function claimRevisionBase(input: ClaimAdmissionInput): number {
  return input.isResubmission
    ? (input.observedGoalRevision ?? input.notificationGoalRevision)
    : input.notificationGoalRevision;
}

export function gateClaimActorAuthorized(
  input: ClaimAdmissionInput
): { value: ClaimAdmissionInput } | { reason: ClaimAdmissionReason } {
  return isAuthorizedActor(input) ? { value: input } : { reason: 'unauthorized' };
}

export function gateClaimNotificationPending(
  input: ClaimAdmissionInput
): { value: ClaimAdmissionInput } | { reason: ClaimAdmissionReason } {
  return input.notificationStatus === 'pending' ? { value: input } : { reason: 'superseded' };
}

export function gateClaimIdentityBound(
  input: ClaimAdmissionInput
): { value: ClaimAdmissionInput } | { reason: ClaimAdmissionReason } {
  const matches =
    input.claimedGoalId === input.notificationGoalId &&
    input.claimedTaskId === input.notificationTaskId;
  return matches ? { value: input } : { reason: 'identity_mismatch' };
}

export function gateClaimRevisionCurrent(
  input: ClaimAdmissionInput
): { value: ClaimAdmissionInput } | { reason: ClaimAdmissionReason } {
  if (!input.mutatesGoalState) return { value: input };
  return claimRevisionBase(input) === input.currentGoalRevision
    ? { value: input }
    : { reason: 'stale_revision' };
}

export function claimAdmissionOutcome(
  input: ClaimAdmissionInput | ClaimAdmissionReason
): ClaimAdmissionDecision {
  return typeof input === 'string' ? { action: 'deny', reason: input } : { action: 'admit' };
}

export const runClaimAdmission = (superpipe({})('claim-admission') as PipelineAPI)
  .input(['input'])
  .pipe(gateClaimActorAuthorized, 'input', 'result:admission')
  .pipe(gateClaimNotificationPending, 'admission', 'result:admission')
  .pipe(gateClaimIdentityBound, 'admission', 'result:admission')
  .pipe(gateClaimRevisionCurrent, 'admission', 'result:admission')
  .end('admission') as (input: ClaimAdmissionInput) => ClaimAdmissionInput | ClaimAdmissionReason;

export function decideClaimAdmission(input: ClaimAdmissionInput): ClaimAdmissionDecision {
  return claimAdmissionOutcome(runClaimAdmission(input));
}

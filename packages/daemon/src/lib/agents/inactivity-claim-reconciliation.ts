import type { InactivityWatchdogDeps } from './inactivity-watchdog-contracts';
import { INACTIVITY_CLAIM_LEASE_MS } from './inactivity-watchdog-contracts';

export type InactivityClaimReconciliationDeps = Pick<
  InactivityWatchdogDeps,
  'claimRepo' | 'isNagDeliveryPending' | 'isNagDeliveryFailed'
>;

export function reconcileInactivityClaim(
  deps: InactivityClaimReconciliationDeps,
  spaceId: string,
  agentId: string,
  configRevision: number | null,
  lastActivityAt: number
): void {
  let claim = deps.claimRepo.getByAgent(spaceId, agentId);
  if (claim !== null && claim.degraded && claim.windowAnchoredAt < lastActivityAt) {
    deps.claimRepo.clearDegraded(spaceId, agentId);
    claim = null;
  }
  if (claim !== null && claim.degraded && claim.configRevision !== configRevision) {
    deps.claimRepo.applyReset(
      spaceId,
      agentId,
      claim.id,
      claim.claimKey,
      claim.ownerToken,
      claim.configRevision,
      { releaseClaim: true, markDegraded: false, advanceAttemptGeneration: false }
    );
    claim = null;
  }
  if (
    claim !== null &&
    claim.state !== 'none' &&
    !claim.degraded &&
    !deps.isNagDeliveryPending(spaceId, agentId, claim.claimKey)
  ) {
    const deliveryFailed = deps.isNagDeliveryFailed(spaceId, agentId, claim.claimKey);
    const superseded = claim.configRevision !== configRevision;
    const freshInFlight =
      claim.state === 'in_flight' &&
      !deliveryFailed &&
      claim.updatedAt > Date.now() - INACTIVITY_CLAIM_LEASE_MS;
    if (!freshInFlight) {
      deps.claimRepo.applyReset(
        spaceId,
        agentId,
        claim.id,
        claim.claimKey,
        claim.ownerToken,
        claim.configRevision,
        deliveryFailed && !superseded
          ? { releaseClaim: false, markDegraded: true, advanceAttemptGeneration: true }
          : { releaseClaim: true, markDegraded: false, advanceAttemptGeneration: false }
      );
    }
  }
}

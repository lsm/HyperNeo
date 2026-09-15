import type { SpaceManager } from '../space/managers/space-manager';
import type {
  SpaceAgentInactivityClaimRepository,
  SpaceAgentInactivityConfigRepository,
  SpaceAgentInactivityClaim,
} from '../../storage/repositories/space-agent-inactivity-repository';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository';

export const INACTIVITY_NAG_PROMPT_MAX_CHARS = 4000;
export const INACTIVITY_NAG_DELIVERY_TIMEOUT_MS = 30_000;
export const INACTIVITY_CLAIM_LEASE_MS = 5 * 60 * 1000;

export const DEFAULT_INACTIVITY_NAG_PROMPT =
  'You have been idle for a while. Check your goals, reminders, and pending reviews; if nothing needs you, say so briefly and stand by.';

export type InactivityNagDeliveryOutcome =
  | 'consumed'
  | 'accepted'
  | 'terminal_failure'
  | 'terminal_failure_after_consumption'
  | 'pre_admission_failure';

export interface InactivityWatchdogSessionSnapshot {
  latestConsumedMessageAt: number | null;
  latestConsumedUserMessageAt: number | null;
  sessionCreatedAt: number | null;
  busyWithOtherWork: boolean;
  pendingOtherAcceptedDelivery: boolean;
}

export interface InactivityWatchdogDeps {
  configRepo: SpaceAgentInactivityConfigRepository;
  claimRepo: SpaceAgentInactivityClaimRepository;
  agentRepo: Pick<SpaceLongHorizonAgentRepository, 'getById' | 'listBySpaceId'>;
  spaceManager: Pick<SpaceManager, 'getSpace'>;
  scannerToken: string;
  now?: () => number;
  deliveryTimeoutMs?: number;
  shouldAbort?: () => boolean;
  getSessionSnapshot(spaceId: string, agentId: string): InactivityWatchdogSessionSnapshot | null;
  isNagDeliveryPending(spaceId: string, agentId: string, claimKey: string): boolean;
  isNagDeliveryFailed(spaceId: string, agentId: string, claimKey: string): boolean;
  deliverNag(args: {
    spaceId: string;
    agentId: string;
    prompt: string;
    idempotencyKey: string;
    configRevision: number | null;
  }): Promise<InactivityNagDeliveryOutcome>;
}

export function applyRunNowBaseline(
  session: InactivityWatchdogSessionSnapshot,
  activityBaseline: number | undefined,
  invokedAt: number | undefined,
  invokingUserMsgAt: number | null | undefined,
  snapshotActivity: number | null
): number | null {
  if (activityBaseline === undefined || invokedAt === undefined) return snapshotActivity;
  const freshTurnStarted =
    invokingUserMsgAt !== undefined &&
    session.latestConsumedUserMessageAt !== null &&
    session.latestConsumedUserMessageAt > (invokingUserMsgAt ?? 0);
  return freshTurnStarted ? snapshotActivity : activityBaseline;
}

export function boundInactivityNagPrompt(prompt: string | null): string {
  const trimmed = (prompt ?? '').trim();
  const value = trimmed.length > 0 ? trimmed : DEFAULT_INACTIVITY_NAG_PROMPT;
  const codePoints = [...value];
  if (codePoints.length <= INACTIVITY_NAG_PROMPT_MAX_CHARS) return value;
  return `${codePoints.slice(0, INACTIVITY_NAG_PROMPT_MAX_CHARS - 1).join('')}…`;
}

export function claimSnapshotForCore(claim: SpaceAgentInactivityClaim) {
  return {
    state: claim.state,
    windowAnchoredAt: claim.windowAnchoredAt,
    attemptGeneration: claim.attemptGeneration,
    ownerToken: claim.ownerToken,
    configRevision: claim.configRevision,
    degraded: claim.degraded,
  };
}

import superpipe, { type PipelineAPI } from 'superpipe';

export const INACTIVITY_WATCHDOG_PREDICATE_VERSION = 1;

export type InactivityNagSkipReason =
  | 'disabled'
  | 'unconfigured'
  | 'degraded'
  | 'actor_inactive'
  | 'session_busy'
  | 'delivery_pending'
  | 'claim_held'
  | 'stale_claim'
  | 'not_due';

export type InactivityNagDecision =
  | { action: 'none'; reason: InactivityNagSkipReason }
  | {
      action: 'nag';
      predicateVersion: number;
      windowAnchoredAt: number;
      attemptGeneration: number;
      claimKey: string;
      ownerToken: string;
      configRevision: number | null;
      idleForMs: number;
    };

export interface InactivityWatchdogActorSnapshot {
  agentStatus: 'active' | 'paused' | 'disabled' | 'archived';
  spaceWakeable: boolean;
  busyWithOtherWork: boolean;
  pendingOtherAcceptedDelivery: boolean;
  lastActivityAt: number;
}

export interface InactivityWatchdogClaimSnapshot {
  state: 'none' | 'accepted' | 'in_flight';
  windowAnchoredAt: number;
  attemptGeneration: number;
  ownerToken: string | null;
  configRevision: number | null;
  degraded: boolean;
}

export interface InactivityWatchdogInput {
  now: number;
  enabled: boolean;
  thresholdMs: number | null;
  configRevision: number | null;
  agentId: string;
  callerToken: string;
  admissionRecheck: boolean;
  actor: InactivityWatchdogActorSnapshot | null;
  claim: InactivityWatchdogClaimSnapshot | null;
}

export type InactivityWatchdogSkipReason = InactivityNagSkipReason;

export function resolveLastActivityAt(baseline: {
  latestConsumedMessageAt: number | null;
  sessionCreatedAt: number | null;
  agentCreatedAt: number | null;
}): number | null {
  return (
    baseline.latestConsumedMessageAt ?? baseline.sessionCreatedAt ?? baseline.agentCreatedAt ?? null
  );
}

export function buildInactivityNagClaimKey(input: {
  agentId: string;
  windowAnchoredAt: number;
  attemptGeneration: number;
}): string {
  return `inactivity-nag:${input.agentId}:${input.windowAnchoredAt}:${input.attemptGeneration}`;
}

export function claimAnchoredToCurrentWindow(input: InactivityWatchdogInput): boolean {
  const claim = input.claim;
  if (claim === null) return false;
  const currentWindow = input.actor?.lastActivityAt ?? null;
  return currentWindow !== null && claim.windowAnchoredAt === currentWindow;
}

export function gateWatchdogEnabled(
  input: InactivityWatchdogInput
): { value: InactivityWatchdogInput } | { reason: InactivityWatchdogSkipReason } {
  return input.enabled ? { value: input } : { reason: 'disabled' };
}

export function gateWatchdogConfigured(
  input: InactivityWatchdogInput
): { value: InactivityWatchdogInput } | { reason: InactivityWatchdogSkipReason } {
  const threshold = input.thresholdMs;
  const configured = threshold !== null && Number.isFinite(threshold) && threshold > 0;
  return configured ? { value: input } : { reason: 'unconfigured' };
}

export function gateClaimNotDegraded(
  input: InactivityWatchdogInput
): { value: InactivityWatchdogInput } | { reason: InactivityWatchdogSkipReason } {
  const blocked = input.claim?.degraded === true && claimAnchoredToCurrentWindow(input);
  return blocked ? { reason: 'degraded' } : { value: input };
}

export function gateClaimCurrent(
  input: InactivityWatchdogInput
): { value: InactivityWatchdogInput } | { reason: InactivityWatchdogSkipReason } {
  if (!input.admissionRecheck) return { value: input };
  const claim = input.claim;
  if (claim === null || claim.state === 'none') return { reason: 'stale_claim' };
  if (!claimAnchoredToCurrentWindow(input)) return { reason: 'stale_claim' };
  if (claim.configRevision !== input.configRevision) return { reason: 'stale_claim' };
  if (claim.ownerToken !== input.callerToken) return { reason: 'claim_held' };
  return { value: input };
}

export function gateActorWakeable(
  input: InactivityWatchdogInput
): { value: InactivityWatchdogInput } | { reason: InactivityWatchdogSkipReason } {
  const actor = input.actor;
  if (actor === null) return { reason: 'actor_inactive' };
  if (actor.agentStatus !== 'active') return { reason: 'actor_inactive' };
  if (!actor.spaceWakeable) return { reason: 'actor_inactive' };
  return { value: input };
}

export function gateSessionIdle(
  input: InactivityWatchdogInput
): { value: InactivityWatchdogInput } | { reason: InactivityWatchdogSkipReason } {
  return input.actor?.busyWithOtherWork ? { reason: 'session_busy' } : { value: input };
}

export function gateDeliverySettled(
  input: InactivityWatchdogInput
): { value: InactivityWatchdogInput } | { reason: InactivityWatchdogSkipReason } {
  return input.actor?.pendingOtherAcceptedDelivery
    ? { reason: 'delivery_pending' }
    : { value: input };
}

export function gateClaimNotHeld(
  input: InactivityWatchdogInput
): { value: InactivityWatchdogInput } | { reason: InactivityWatchdogSkipReason } {
  const claim = input.claim;
  if (claim === null || claim.state === 'none') return { value: input };
  if (!claimAnchoredToCurrentWindow(input)) return { value: input };
  if (claim.configRevision !== input.configRevision) return { value: input };
  if (claim.ownerToken === input.callerToken) return { value: input };
  return { reason: 'claim_held' };
}

export function gateActorDue(
  input: InactivityWatchdogInput
): { value: InactivityWatchdogInput } | { reason: InactivityWatchdogSkipReason } {
  const actor = input.actor;
  if (actor === null) return { reason: 'not_due' };
  const idleForMs = input.now - actor.lastActivityAt;
  if (idleForMs < (input.thresholdMs ?? Infinity)) return { reason: 'not_due' };
  return { value: input };
}

export function buildInactivityNag(
  input: InactivityWatchdogInput
): { value: InactivityNagDecision } | { reason: InactivityWatchdogSkipReason } {
  const actor = input.actor;
  if (actor === null) return { reason: 'actor_inactive' };
  const attemptGeneration = input.claim?.attemptGeneration ?? 0;
  const windowAnchoredAt = actor.lastActivityAt;
  return {
    value: {
      action: 'nag',
      predicateVersion: INACTIVITY_WATCHDOG_PREDICATE_VERSION,
      windowAnchoredAt,
      attemptGeneration,
      claimKey: buildInactivityNagClaimKey({
        agentId: input.agentId,
        windowAnchoredAt,
        attemptGeneration,
      }),
      ownerToken: input.callerToken,
      configRevision: input.configRevision,
      idleForMs: input.now - actor.lastActivityAt,
    },
  };
}

export const runInactivityWatchdog = (superpipe({})('inactivity-watchdog') as PipelineAPI)
  .input(['input'])
  .pipe(gateWatchdogEnabled, 'input', 'result:admission')
  .pipe(gateWatchdogConfigured, 'admission', 'result:admission')
  .pipe(gateClaimNotDegraded, 'admission', 'result:admission')
  .pipe(gateClaimCurrent, 'admission', 'result:admission')
  .pipe(gateActorWakeable, 'admission', 'result:admission')
  .pipe(gateSessionIdle, 'admission', 'result:admission')
  .pipe(gateDeliverySettled, 'admission', 'result:admission')
  .pipe(gateClaimNotHeld, 'admission', 'result:admission')
  .pipe(gateActorDue, 'admission', 'result:admission')
  .pipe(buildInactivityNag, 'admission', 'result:admission')
  .end('admission') as (
  input: InactivityWatchdogInput
) => InactivityNagDecision | InactivityWatchdogSkipReason;

export function inactivityWatchdogOutcome(
  outcome: InactivityNagDecision | InactivityWatchdogSkipReason
): InactivityNagDecision {
  return typeof outcome === 'string' ? { action: 'none', reason: outcome } : outcome;
}

export function decideInactivityNag(input: InactivityWatchdogInput): InactivityNagDecision {
  return inactivityWatchdogOutcome(runInactivityWatchdog(input));
}
export type InactivityNagDeliveryStage =
  | 'pre_admission_failure'
  | 'accepted'
  | 'consumed'
  | 'terminal_failure';

export interface InactivityNagWindowReset {
  resetWindow: boolean;
  releaseClaim: boolean;
  markDegraded: boolean;
  advanceAttemptGeneration: boolean;
  degraded: boolean;
}

export function decideNagWindowReset(
  stage: InactivityNagDeliveryStage,
  context: { consumed: boolean } = { consumed: false }
): InactivityNagWindowReset {
  switch (stage) {
    case 'pre_admission_failure':
      return {
        resetWindow: false,
        releaseClaim: true,
        markDegraded: false,
        advanceAttemptGeneration: false,
        degraded: false,
      };
    case 'accepted':
      return {
        resetWindow: false,
        releaseClaim: false,
        markDegraded: false,
        advanceAttemptGeneration: false,
        degraded: false,
      };
    case 'consumed':
      return {
        resetWindow: true,
        releaseClaim: true,
        markDegraded: false,
        advanceAttemptGeneration: false,
        degraded: false,
      };
    case 'terminal_failure':
      return {
        resetWindow: false,
        releaseClaim: false,
        markDegraded: true,
        advanceAttemptGeneration: !context.consumed,
        degraded: true,
      };
  }
}

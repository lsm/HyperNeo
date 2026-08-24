import { decisionRun } from '../runtime/decision-pipeline';

export const INACTIVITY_WATCHDOG_PREDICATE_VERSION = 1;

export type InactivityNagSkipReason =
  | 'disabled'
  | 'unconfigured'
  | 'actor_inactive'
  | 'session_busy'
  | 'delivery_pending'
  | 'claim_held'
  | 'not_due';

export type InactivityNagDecision =
  | { action: 'none'; reason: InactivityNagSkipReason }
  | {
      action: 'nag';
      predicateVersion: number;
      windowAnchoredAt: number;
      attemptGeneration: number;
      claimKey: string;
      idleForMs: number;
    };

export interface InactivityWatchdogActorSnapshot {
  agentStatus: 'active' | 'paused' | 'disabled' | 'archived';
  spaceWakeable: boolean;
  sessionIdle: boolean;
  pendingAcceptedDelivery: boolean;
  lastActivityAt: number;
}

export interface InactivityWatchdogClaimSnapshot {
  state: 'none' | 'accepted' | 'in_flight';
  windowAnchoredAt: number;
  attemptGeneration: number;
}

export interface InactivityWatchdogCtx {
  now: number;
  enabled: boolean;
  thresholdMs: number | null;
  agentId: string;
  actor: InactivityWatchdogActorSnapshot | null;
  claim: InactivityWatchdogClaimSnapshot | null;
  decision: InactivityNagDecision | null;
}

export type InactivityWatchdogInput = Omit<InactivityWatchdogCtx, 'decision'>;

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

function decided(
  ctx: InactivityWatchdogCtx,
  decision: InactivityNagDecision
): InactivityWatchdogCtx {
  return { ...ctx, decision };
}

export function applyWatchdogDisabledGate(ctx: InactivityWatchdogCtx): InactivityWatchdogCtx {
  return ctx.enabled ? ctx : decided(ctx, { action: 'none', reason: 'disabled' });
}

export function applyWatchdogUnconfiguredGate(ctx: InactivityWatchdogCtx): InactivityWatchdogCtx {
  const threshold = ctx.thresholdMs;
  return threshold !== null && Number.isFinite(threshold) && threshold > 0
    ? ctx
    : decided(ctx, { action: 'none', reason: 'unconfigured' });
}

export function applyActorInactiveGate(ctx: InactivityWatchdogCtx): InactivityWatchdogCtx {
  const actor = ctx.actor;
  if (actor === null) return decided(ctx, { action: 'none', reason: 'actor_inactive' });
  if (actor.agentStatus !== 'active') {
    return decided(ctx, { action: 'none', reason: 'actor_inactive' });
  }
  if (!actor.spaceWakeable) return decided(ctx, { action: 'none', reason: 'actor_inactive' });
  return ctx;
}

export function applyBusySessionGate(ctx: InactivityWatchdogCtx): InactivityWatchdogCtx {
  return ctx.actor?.sessionIdle ? ctx : decided(ctx, { action: 'none', reason: 'session_busy' });
}

export function applyPendingDeliveryGate(ctx: InactivityWatchdogCtx): InactivityWatchdogCtx {
  return ctx.actor?.pendingAcceptedDelivery
    ? decided(ctx, { action: 'none', reason: 'delivery_pending' })
    : ctx;
}

export function applyClaimHeldGate(ctx: InactivityWatchdogCtx): InactivityWatchdogCtx {
  const claim = ctx.claim;
  if (claim === null || claim.state === 'none') return ctx;
  const currentWindow = ctx.actor?.lastActivityAt ?? null;
  if (currentWindow !== null && claim.windowAnchoredAt !== currentWindow) return ctx;
  return decided(ctx, { action: 'none', reason: 'claim_held' });
}

export function applyNotDueGate(ctx: InactivityWatchdogCtx): InactivityWatchdogCtx {
  const actor = ctx.actor;
  if (actor === null) return decided(ctx, { action: 'none', reason: 'not_due' });
  const idleForMs = ctx.now - actor.lastActivityAt;
  if (idleForMs < (ctx.thresholdMs ?? Infinity)) {
    return decided(ctx, { action: 'none', reason: 'not_due' });
  }
  return ctx;
}

export function applyNagGate(ctx: InactivityWatchdogCtx): InactivityWatchdogCtx {
  const actor = ctx.actor;
  if (actor === null) return decided(ctx, { action: 'none', reason: 'actor_inactive' });
  const attemptGeneration = ctx.claim?.attemptGeneration ?? 0;
  const windowAnchoredAt = actor.lastActivityAt;
  return decided(ctx, {
    action: 'nag',
    predicateVersion: INACTIVITY_WATCHDOG_PREDICATE_VERSION,
    windowAnchoredAt,
    attemptGeneration,
    claimKey: buildInactivityNagClaimKey({
      agentId: ctx.agentId,
      windowAnchoredAt,
      attemptGeneration,
    }),
    idleForMs: ctx.now - actor.lastActivityAt,
  });
}

const inactivityWatchdogRun = decisionRun('inactivity-watchdog', [
  applyWatchdogDisabledGate,
  applyWatchdogUnconfiguredGate,
  applyActorInactiveGate,
  applyBusySessionGate,
  applyPendingDeliveryGate,
  applyClaimHeldGate,
  applyNotDueGate,
  applyNagGate,
]);

export function decideInactivityNag(input: InactivityWatchdogInput): InactivityNagDecision {
  const ctx = inactivityWatchdogRun(input);
  return ctx.decision ?? { action: 'none', reason: 'not_due' };
}

export type InactivityNagDeliveryStage =
  | 'pre_admission_failure'
  | 'accepted'
  | 'consumed'
  | 'terminal_failure';

export interface InactivityNagWindowReset {
  resetWindow: boolean;
  releaseClaim: boolean;
  advanceAttemptGeneration: boolean;
  degraded: boolean;
}

export function decideNagWindowReset(stage: InactivityNagDeliveryStage): InactivityNagWindowReset {
  switch (stage) {
    case 'pre_admission_failure':
      return {
        resetWindow: false,
        releaseClaim: true,
        advanceAttemptGeneration: false,
        degraded: false,
      };
    case 'accepted':
      return {
        resetWindow: false,
        releaseClaim: false,
        advanceAttemptGeneration: false,
        degraded: false,
      };
    case 'consumed':
      return {
        resetWindow: true,
        releaseClaim: true,
        advanceAttemptGeneration: false,
        degraded: false,
      };
    case 'terminal_failure':
      return {
        resetWindow: false,
        releaseClaim: true,
        advanceAttemptGeneration: true,
        degraded: true,
      };
  }
}

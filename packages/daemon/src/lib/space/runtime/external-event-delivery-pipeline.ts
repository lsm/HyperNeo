import superpipe, { type PipelineAPI } from 'superpipe';
import type { ExternalEventTaskDecision } from './external-event-admission-gates';

export type ExternalEventDeliveryDecision =
  | { action: 'skip' }
  | { action: 'skipClaimConflict' }
  | { action: 'failDelivery'; reason: string }
  | { action: 'deferPausedSpace' }
  | { action: 'deliverLiveSession' }
  | { action: 'deliverStaleSession' }
  | {
      action: 'queueForActivation';
      reason: string;
      preserveAttemptCount?: boolean;
      retryUnlessPaused?: boolean;
    }
  | { action: 'deferNotActive' }
  | { action: 'activateTarget' };

export interface ExternalEventDeliveryCtx {
  deliveryTerminal: boolean;
  deliveryInFlight: boolean;
  subscriptionActive: boolean;
  taskDecision: ExternalEventTaskDecision;
  targetHasSession: boolean;
  targetSessionLive: boolean;
  targetSpacePaused: boolean;
  executionPendingActivation: boolean;
  decision: ExternalEventDeliveryDecision | null;
}

export type ExternalEventDeliveryInput = Omit<ExternalEventDeliveryCtx, 'decision'>;

export interface PostActivationDeliveryCtx {
  activationError: string | null;
  activatedTargetFound: boolean;
  activatedHasSession: boolean;
  activatedSessionLive: boolean;
  decision: ExternalEventDeliveryDecision | null;
}

export type PostActivationDeliveryInput = Omit<PostActivationDeliveryCtx, 'decision'>;

function decided<T extends { decision: ExternalEventDeliveryDecision | null }>(
  ctx: T,
  decision: ExternalEventDeliveryDecision
): T {
  return { ...ctx, decision };
}

export function applyTerminalGate(ctx: ExternalEventDeliveryCtx): ExternalEventDeliveryCtx {
  return ctx.deliveryTerminal ? decided(ctx, { action: 'skip' }) : ctx;
}

export function applyClaimConflictGate(ctx: ExternalEventDeliveryCtx): ExternalEventDeliveryCtx {
  return ctx.deliveryInFlight ? decided(ctx, { action: 'skipClaimConflict' }) : ctx;
}

export function applySubscriptionGate(ctx: ExternalEventDeliveryCtx): ExternalEventDeliveryCtx {
  return ctx.subscriptionActive
    ? ctx
    : decided(ctx, { action: 'failDelivery', reason: 'subscription_no_longer_active' });
}

export function applyTaskAdmissionGate(ctx: ExternalEventDeliveryCtx): ExternalEventDeliveryCtx {
  return ctx.taskDecision.action === 'deliver'
    ? ctx
    : decided(ctx, { action: 'failDelivery', reason: ctx.taskDecision.reason });
}

export function applySessionRoutingGate(ctx: ExternalEventDeliveryCtx): ExternalEventDeliveryCtx {
  if (!ctx.targetHasSession) return ctx;
  if (!ctx.targetSessionLive) return decided(ctx, { action: 'deliverStaleSession' });
  if (ctx.targetSpacePaused) return decided(ctx, { action: 'deferPausedSpace' });
  return decided(ctx, { action: 'deliverLiveSession' });
}

export function applyExecutionRoutingGate(ctx: ExternalEventDeliveryCtx): ExternalEventDeliveryCtx {
  if (ctx.executionPendingActivation) {
    return decided(ctx, {
      action: 'queueForActivation',
      reason: 'deliveryMode:defer; node_execution_pending',
      preserveAttemptCount: true,
    });
  }
  return decided(ctx, { action: 'activateTarget' });
}

export function applyActivationErrorGate(
  ctx: PostActivationDeliveryCtx
): PostActivationDeliveryCtx {
  return ctx.activationError === null
    ? ctx
    : decided(ctx, {
        action: 'queueForActivation',
        reason: `deliveryMode:defer; activation_failed; ${ctx.activationError}`,
      });
}

export function applyActivatedRoutingGate(
  ctx: PostActivationDeliveryCtx
): PostActivationDeliveryCtx {
  if (!ctx.activatedTargetFound) {
    return decided(ctx, {
      action: 'queueForActivation',
      reason: 'deliveryMode:defer; node_execution_not_active',
      retryUnlessPaused: true,
    });
  }
  if (!ctx.activatedHasSession) return decided(ctx, { action: 'deferNotActive' });
  if (!ctx.activatedSessionLive) return decided(ctx, { action: 'deliverStaleSession' });
  return decided(ctx, { action: 'deliverLiveSession' });
}

const deliveryDecisionRun = (
  superpipe<{
    hasDecision: (ctx: ExternalEventDeliveryCtx) => boolean;
  }>({
    hasDecision: (ctx: ExternalEventDeliveryCtx): boolean => ctx.decision !== null,
  })('external-event-delivery') as PipelineAPI
)
  .input(['ctx'])
  .pipe(applyTerminalGate, 'ctx', 'ctx')
  .pipe('!hasDecision', 'ctx')
  .pipe(applyClaimConflictGate, 'ctx', 'ctx')
  .pipe('!hasDecision', 'ctx')
  .pipe(applySubscriptionGate, 'ctx', 'ctx')
  .pipe('!hasDecision', 'ctx')
  .pipe(applyTaskAdmissionGate, 'ctx', 'ctx')
  .pipe('!hasDecision', 'ctx')
  .pipe(applySessionRoutingGate, 'ctx', 'ctx')
  .pipe('!hasDecision', 'ctx')
  .pipe(applyExecutionRoutingGate, 'ctx', 'ctx')
  .end('ctx');

const postActivationDecisionRun = (
  superpipe<{
    hasDecision: (ctx: PostActivationDeliveryCtx) => boolean;
  }>({
    hasDecision: (ctx: PostActivationDeliveryCtx): boolean => ctx.decision !== null,
  })('external-event-post-activation') as PipelineAPI
)
  .input(['ctx'])
  .pipe(applyActivationErrorGate, 'ctx', 'ctx')
  .pipe('!hasDecision', 'ctx')
  .pipe(applyActivatedRoutingGate, 'ctx', 'ctx')
  .end('ctx');

export function decideExternalEventDelivery(
  input: ExternalEventDeliveryInput
): ExternalEventDeliveryDecision {
  const ctx = deliveryDecisionRun({ ...input, decision: null }) as ExternalEventDeliveryCtx;
  return ctx.decision ?? { action: 'skip' };
}

export function decidePostActivationDelivery(
  input: PostActivationDeliveryInput
): ExternalEventDeliveryDecision {
  const ctx = postActivationDecisionRun({
    ...input,
    decision: null,
  }) as PostActivationDeliveryCtx;
  return ctx.decision ?? { action: 'skip' };
}

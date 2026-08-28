import type { AgentProcessingState } from '@hyperneo/shared';
import type { DeliveryLoadResult, MessageDeliveryRole } from './message-delivery.ts';
import { resolveDeliveryRole } from './message-ownership-gates.ts';

export function isSteerDeliveryValid(args: {
  sessionArchived: boolean;
  row: DeliveryLoadResult | null;
}): boolean {
  return !args.sessionArchived && args.row !== null && args.row.sendStatus === 'enqueued';
}

export type SteerAdmissionDecision =
  | { action: 'aborted'; reason: 'claim_superseded' | 'delivery_invalid' }
  | { action: 'promote' }
  | { action: 'park' }
  | { action: 'awaiting_acceptance' }
  | { action: 'feed' };

export interface SteerAdmissionCtx {
  claimCurrent: boolean;
  status: AgentProcessingState['status'];
  deliveryValid: boolean;
  hasLiveQuery: boolean;
  provider: string;
  queueOwnsMessage: boolean;
  admission: SteerAdmissionDecision | null;
}

export function resolveSteerAdmission(args: {
  claimCurrent: boolean;
  status: AgentProcessingState['status'];
  deliveryValid: boolean;
  hasLiveQuery: boolean;
  provider: string;
  queueOwnsMessage: boolean;
}): SteerAdmissionDecision {
  if (!args.claimCurrent) return { action: 'aborted', reason: 'claim_superseded' };
  if (args.status === 'processing') {
    if (!args.deliveryValid) return { action: 'aborted', reason: 'delivery_invalid' };
    if (!args.hasLiveQuery) return { action: 'promote' };
    if (args.provider === 'acp' && args.queueOwnsMessage) {
      return { action: 'awaiting_acceptance' };
    }
    return { action: 'feed' };
  }
  if (args.status === 'queued') return { action: 'park' };
  return { action: 'promote' };
}

function decided(ctx: SteerAdmissionCtx, admission: SteerAdmissionDecision): SteerAdmissionCtx {
  return { ...ctx, admission };
}

export function applyClaimSupersededGate(ctx: SteerAdmissionCtx): SteerAdmissionCtx {
  if (ctx.admission !== null) return ctx;
  return !ctx.claimCurrent ? decided(ctx, { action: 'aborted', reason: 'claim_superseded' }) : ctx;
}

export function applyProcessingInvalidGate(ctx: SteerAdmissionCtx): SteerAdmissionCtx {
  if (ctx.admission !== null) return ctx;
  if (ctx.status === 'processing' && !ctx.deliveryValid) {
    return decided(ctx, { action: 'aborted', reason: 'delivery_invalid' });
  }
  return ctx;
}

export function applyProcessingPromoteGate(ctx: SteerAdmissionCtx): SteerAdmissionCtx {
  if (ctx.admission !== null) return ctx;
  if (ctx.status === 'processing' && !ctx.hasLiveQuery) {
    return decided(ctx, { action: 'promote' });
  }
  return ctx;
}

export function applyProcessingAcpAwaitGate(ctx: SteerAdmissionCtx): SteerAdmissionCtx {
  if (ctx.admission !== null) return ctx;
  if (ctx.status === 'processing' && ctx.provider === 'acp' && ctx.queueOwnsMessage) {
    return decided(ctx, { action: 'awaiting_acceptance' });
  }
  return ctx;
}

export function applyProcessingFeedGate(ctx: SteerAdmissionCtx): SteerAdmissionCtx {
  if (ctx.admission !== null) return ctx;
  if (ctx.status === 'processing') {
    return decided(ctx, { action: 'feed' });
  }
  return ctx;
}

export function applyQueuedParkGate(ctx: SteerAdmissionCtx): SteerAdmissionCtx {
  if (ctx.admission !== null) return ctx;
  if (ctx.status === 'queued') {
    return decided(ctx, { action: 'park' });
  }
  return ctx;
}

export function applyPromoteGate(ctx: SteerAdmissionCtx): SteerAdmissionCtx {
  if (ctx.admission !== null) return ctx;
  return decided(ctx, { action: 'promote' });
}

export function classifyAcknowledgedSteer(args: {
  provider: string;
}): 'consumed' | 'awaiting_acceptance' {
  return args.provider === 'acp' ? 'awaiting_acceptance' : 'consumed';
}

export type DeliveryRoleArbitration =
  | { action: 'reuse'; role: MessageDeliveryRole }
  | {
      action: 'enqueue';
      role: MessageDeliveryRole;
      uniqueConstraintFallback: MessageDeliveryRole | null;
    };

export function planDeliveryRoleArbitration(args: {
  existingActiveRole: MessageDeliveryRole | null;
  requestedRole?: MessageDeliveryRole;
}): DeliveryRoleArbitration {
  if (args.existingActiveRole !== null) {
    return {
      action: 'reuse',
      role: resolveDeliveryRole({
        existingActiveRole: args.existingActiveRole,
        requestedRole: args.requestedRole,
        uniqueConstraintHit: false,
      }),
    };
  }
  const constrained = resolveDeliveryRole({
    existingActiveRole: null,
    requestedRole: args.requestedRole,
    uniqueConstraintHit: true,
  });
  return {
    action: 'enqueue',
    role: resolveDeliveryRole({
      existingActiveRole: null,
      requestedRole: args.requestedRole,
      uniqueConstraintHit: false,
    }),
    uniqueConstraintFallback:
      args.requestedRole === undefined && constrained !== 'explicit_role_rejected'
        ? constrained
        : null,
  };
}

export function applyReuseGate(args: {
  existingActiveRole: MessageDeliveryRole | null;
  requestedRole?: MessageDeliveryRole;
}): DeliveryRoleArbitration | null {
  if (args.existingActiveRole === null) return null;
  return {
    action: 'reuse',
    role: resolveDeliveryRole({
      existingActiveRole: args.existingActiveRole,
      requestedRole: args.requestedRole,
      uniqueConstraintHit: false,
    }),
  };
}

export function applyEnqueueGate(args: {
  requestedRole?: MessageDeliveryRole;
}): DeliveryRoleArbitration {
  const constrained = resolveDeliveryRole({
    existingActiveRole: null,
    requestedRole: args.requestedRole,
    uniqueConstraintHit: true,
  });
  return {
    action: 'enqueue',
    role: resolveDeliveryRole({
      existingActiveRole: null,
      requestedRole: args.requestedRole,
      uniqueConstraintHit: false,
    }),
    uniqueConstraintFallback:
      args.requestedRole === undefined && constrained !== 'explicit_role_rejected'
        ? constrained
        : null,
  };
}

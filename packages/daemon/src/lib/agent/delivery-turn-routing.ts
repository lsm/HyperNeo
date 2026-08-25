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

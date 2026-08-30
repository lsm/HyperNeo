import type { MessageDeliveryRole } from './message-delivery.ts';
import { resolveDeliveryRole } from './message-ownership-gates.ts';

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

import type { SendStatus } from './sdk-message-admission';

export type DeliveryTransitionAction =
  | 'fail'
  | 'fail_inclusive'
  | 'consume'
  | 'submit'
  | 'reopen'
  | 'retry'
  | 'defer';

interface DeliveryTransitionRule {
  acceptedFrom: readonly SendStatus[];
  target: SendStatus;
}

const DELIVERY_TRANSITION_RULES: Readonly<
  Record<DeliveryTransitionAction, DeliveryTransitionRule>
> = {
  fail: { acceptedFrom: ['enqueued', 'deferred', 'submitted'], target: 'failed' },
  fail_inclusive: { acceptedFrom: ['enqueued', 'submitted', 'consumed'], target: 'failed' },
  consume: { acceptedFrom: ['enqueued', 'submitted'], target: 'consumed' },
  submit: { acceptedFrom: ['enqueued'], target: 'submitted' },
  reopen: { acceptedFrom: ['failed'], target: 'enqueued' },
  retry: { acceptedFrom: ['consumed'], target: 'enqueued' },
  defer: { acceptedFrom: ['enqueued'], target: 'deferred' },
};

export interface DeliveryTransitionRouting {
  accepted: boolean;
  targetStatus: SendStatus;
}

export function routeDeliveryTransition(
  currentStatus: string | null | undefined,
  action: DeliveryTransitionAction
): DeliveryTransitionRouting {
  const rule = DELIVERY_TRANSITION_RULES[action];
  return {
    accepted: rule.acceptedFrom.includes(currentStatus as SendStatus),
    targetStatus: rule.target,
  };
}

export function deliveryTransitionRule(action: DeliveryTransitionAction): DeliveryTransitionRule {
  return DELIVERY_TRANSITION_RULES[action];
}

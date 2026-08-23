import { describe, expect, test } from 'bun:test';
import {
  type DeliveryTransitionAction,
  deliveryTransitionRule,
  routeDeliveryTransition,
} from '../../../../src/storage/repositories/delivery-status-routing';
import type { SendStatus } from '../../../../src/storage/repositories/sdk-message-admission';

const ALL_STATUSES = ['deferred', 'enqueued', 'submitted', 'consumed', 'failed'] as const;

const ACTIONS: ReadonlyArray<{
  action: DeliveryTransitionAction;
  wrappers: readonly string[];
  acceptedFrom: readonly SendStatus[];
  target: SendStatus;
}> = [
  {
    action: 'fail',
    wrappers: ['markDeliveryFailedByUuid'],
    acceptedFrom: ['enqueued', 'deferred', 'submitted'],
    target: 'failed',
  },
  {
    action: 'fail_inclusive',
    wrappers: ['markDeliveryFailedByUuidInclusive'],
    acceptedFrom: ['enqueued', 'submitted', 'consumed'],
    target: 'failed',
  },
  {
    action: 'consume',
    wrappers: [
      'markDeliveryConsumedByUuid',
      'markDeliveryConsumedAtTurnEnd',
      'markDeliveriesConsumedAtTurnEnd',
      'markDeliveryConsumedByUuids',
    ],
    acceptedFrom: ['enqueued', 'submitted'],
    target: 'consumed',
  },
  {
    action: 'submit',
    wrappers: ['markDeliverySubmittedByUuids'],
    acceptedFrom: ['enqueued'],
    target: 'submitted',
  },
  {
    action: 'reopen',
    wrappers: ['reopenDeliveryByUuid'],
    acceptedFrom: ['failed'],
    target: 'enqueued',
  },
  {
    action: 'retry',
    wrappers: ['markDeliveryRetryableByUuid'],
    acceptedFrom: ['consumed'],
    target: 'enqueued',
  },
  {
    action: 'defer',
    wrappers: ['markDeliveryDeferredByUuid', 'deferEnqueuedUserMessage'],
    acceptedFrom: ['enqueued'],
    target: 'deferred',
  },
];

describe('routeDeliveryTransition', () => {
  for (const { action, wrappers, acceptedFrom, target } of ACTIONS) {
    test(`${action} (${wrappers.join(', ')}): ${acceptedFrom.join('/')} → ${target}; every other from-status routes unaccepted`, () => {
      for (const status of ALL_STATUSES) {
        expect(routeDeliveryTransition(status, action)).toEqual({
          accepted: acceptedFrom.includes(status),
          targetStatus: target,
        });
      }
    });
  }

  test('treats null, empty, unknown, and case-mismatched statuses as unaccepted for every action', () => {
    for (const status of [null, undefined, '', 'migrated', 'ENQUEUED', 'queued'] as Array<
      string | null | undefined
    >) {
      for (const { action, target } of ACTIONS) {
        expect(routeDeliveryTransition(status, action)).toEqual({
          accepted: false,
          targetStatus: target,
        });
      }
    }
  });
});

describe('deliveryTransitionRule', () => {
  test('exposes the shared window and target each wrapper parameterizes its lookup and update from', () => {
    for (const { action, acceptedFrom, target } of ACTIONS) {
      expect(deliveryTransitionRule(action)).toEqual({ acceptedFrom, target });
    }
  });
});

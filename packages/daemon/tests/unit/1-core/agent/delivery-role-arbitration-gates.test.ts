import { describe, expect, it } from 'bun:test';
import type { MessageDeliveryRole } from '../../../../src/lib/agent/message-delivery';
import {
  applyEnqueueGate,
  applyReuseGate,
  planDeliveryRoleArbitration,
  type DeliveryRoleArbitration,
} from '../../../../src/lib/agent/delivery-turn-routing';
import { resolveDeliveryRole } from '../../../../src/lib/agent/message-ownership-gates';

const ACTIVE_ROLES: MessageDeliveryRole[] = ['turn', 'steer'];
const REQUESTED_ROLES: (MessageDeliveryRole | undefined)[] = ['turn', 'steer', undefined];

describe('planDeliveryRoleArbitration', () => {
  it('reuses an active role over every requested role', () => {
    for (const existingActiveRole of ACTIVE_ROLES) {
      for (const requestedRole of REQUESTED_ROLES) {
        const expected: DeliveryRoleArbitration = {
          action: 'reuse',
          role: existingActiveRole,
        };
        expect(planDeliveryRoleArbitration({ existingActiveRole, requestedRole })).toEqual(
          expected
        );
      }
    }
  });

  it('enqueues the resolved role with the correct unique-constraint fallback', () => {
    for (const requestedRole of REQUESTED_ROLES) {
      const role = resolveDeliveryRole({
        existingActiveRole: null,
        requestedRole,
        uniqueConstraintHit: false,
      });
      const constrained = resolveDeliveryRole({
        existingActiveRole: null,
        requestedRole,
        uniqueConstraintHit: true,
      });
      const uniqueConstraintFallback: MessageDeliveryRole | null =
        requestedRole === undefined && constrained !== 'explicit_role_rejected'
          ? constrained
          : null;
      const expected: DeliveryRoleArbitration = {
        action: 'enqueue',
        role,
        uniqueConstraintFallback,
      };
      expect(planDeliveryRoleArbitration({ existingActiveRole: null, requestedRole })).toEqual(
        expected
      );
    }
  });

  it('never exposes explicit_role_rejected in the uniqueConstraintFallback', () => {
    for (const existingActiveRole of [...ACTIVE_ROLES, null]) {
      for (const requestedRole of REQUESTED_ROLES) {
        const result = planDeliveryRoleArbitration({ existingActiveRole, requestedRole });
        if (result.action === 'enqueue') {
          expect(result.uniqueConstraintFallback).not.toBe('explicit_role_rejected');
        }
      }
    }
  });
});

describe('applyReuseGate', () => {
  it('fires only with an active role and reuses it over every requested role', () => {
    for (const existingActiveRole of ACTIVE_ROLES) {
      for (const requestedRole of REQUESTED_ROLES) {
        expect(applyReuseGate({ existingActiveRole, requestedRole })).toEqual({
          action: 'reuse',
          role: existingActiveRole,
        });
      }
    }
  });

  it('does not fire without an active role', () => {
    for (const requestedRole of REQUESTED_ROLES) {
      expect(applyReuseGate({ existingActiveRole: null, requestedRole })).toBeNull();
    }
  });
});

describe('applyEnqueueGate', () => {
  it('matches the hand-rolled enqueue decision for every requested role', () => {
    for (const requestedRole of REQUESTED_ROLES) {
      expect(applyEnqueueGate({ requestedRole })).toEqual(
        planDeliveryRoleArbitration({ existingActiveRole: null, requestedRole })
      );
    }
  });

  it('never exposes explicit_role_rejected in the uniqueConstraintFallback', () => {
    for (const requestedRole of REQUESTED_ROLES) {
      const result = applyEnqueueGate({ requestedRole });
      expect(result.action).toBe('enqueue');
      if (result.action === 'enqueue') {
        expect(result.uniqueConstraintFallback).not.toBe('explicit_role_rejected');
      }
    }
  });
});

describe('arbitration gate cascade', () => {
  it('applyReuseGate ?? applyEnqueueGate equals planDeliveryRoleArbitration everywhere', () => {
    for (const existingActiveRole of [...ACTIVE_ROLES, null]) {
      for (const requestedRole of REQUESTED_ROLES) {
        expect(
          applyReuseGate({ existingActiveRole, requestedRole }) ??
            applyEnqueueGate({ requestedRole })
        ).toEqual(planDeliveryRoleArbitration({ existingActiveRole, requestedRole }));
      }
    }
  });
});

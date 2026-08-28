import { describe, expect, it } from 'bun:test';
import type { MessageDeliveryRole } from '../../../../src/lib/agent/message-delivery';
import {
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

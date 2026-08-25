import { describe, expect, it } from 'bun:test';
import type { AgentProcessingState } from '@hyperneo/shared';
import type { SteerAdmissionDecision } from '../../../../src/lib/agent/delivery-turn-routing';
import {
  classifyAcknowledgedSteer,
  isSteerDeliveryValid,
  planDeliveryRoleArbitration,
  resolveSteerAdmission,
} from '../../../../src/lib/agent/delivery-turn-routing';

type SteerInput = Parameters<typeof resolveSteerAdmission>[0];

function steerRow(overrides: Partial<SteerInput>): SteerInput {
  return {
    claimCurrent: true,
    status: 'processing',
    deliveryValid: true,
    hasLiveQuery: true,
    provider: 'anthropic',
    queueOwnsMessage: false,
    ...overrides,
  };
}

const STATUSES: AgentProcessingState['status'][] = [
  'idle',
  'queued',
  'processing',
  'waiting_for_input',
  'rate_limit_cooldown',
  'interrupted',
];

describe('resolveSteerAdmission', () => {
  it.each(
    STATUSES.map((status) => [`superseded claim aborts at ${status}`, status])
  )('%s', (_label, status) => {
    expect(
      resolveSteerAdmission(
        steerRow({ status, claimCurrent: false, deliveryValid: false, hasLiveQuery: false })
      )
    ).toEqual({ action: 'aborted', reason: 'claim_superseded' });
  });

  it.each([
    ['processing aborts on an invalid delivery', steerRow({ deliveryValid: false })],
    [
      'processing aborts on an invalid delivery even when no query is live',
      steerRow({ deliveryValid: false, hasLiveQuery: false }),
    ],
    [
      'processing aborts an invalid ACP steer ahead of ownership',
      steerRow({ deliveryValid: false, provider: 'acp', queueOwnsMessage: true }),
    ],
  ])('%s', (_label, input) => {
    expect(resolveSteerAdmission(input)).toEqual({ action: 'aborted', reason: 'delivery_invalid' });
  });

  it.each([
    ['processing promotes when no query is live', steerRow({ hasLiveQuery: false }), 'promote'],
    [
      'processing promotes an absent-query ACP steer ahead of ownership',
      steerRow({ hasLiveQuery: false, provider: 'acp', queueOwnsMessage: true }),
      'promote',
    ],
    [
      'ACP with an already-pending steer awaits acceptance without a fresh feed',
      steerRow({ provider: 'acp', queueOwnsMessage: true }),
      'awaiting_acceptance',
    ],
    ['ACP with a fresh steer admits a feed', steerRow({ provider: 'acp' }), 'feed'],
    [
      'non-ACP with an already-pending steer still admits a feed',
      steerRow({ queueOwnsMessage: true }),
      'feed',
    ],
    ['non-ACP with a fresh steer admits a feed', steerRow({}), 'feed'],
  ])('%s', (_label, input, expected) => {
    const decision: SteerAdmissionDecision = resolveSteerAdmission(input);
    expect(decision.action).toBe(expected);
  });

  it.each([
    [
      'queued parks regardless of validity, live query, ACP provider, and pending steer',
      steerRow({ status: 'queued', deliveryValid: false, provider: 'acp', queueOwnsMessage: true }),
    ],
    [
      'queued parks even with an absent query and a fresh valid delivery',
      steerRow({ status: 'queued', hasLiveQuery: false }),
    ],
  ])('%s', (_label, input) => {
    expect(resolveSteerAdmission(input)).toEqual({ action: 'park' });
  });

  it.each([
    ['idle promotes', steerRow({ status: 'idle' })],
    [
      'idle promotes regardless of validity and pending ACP ownership',
      steerRow({
        status: 'idle',
        deliveryValid: false,
        hasLiveQuery: false,
        provider: 'acp',
        queueOwnsMessage: true,
      }),
    ],
    ['waiting_for_input promotes', steerRow({ status: 'waiting_for_input' })],
    [
      'waiting_for_input promotes ahead of ACP pending ownership',
      steerRow({ status: 'waiting_for_input', provider: 'acp', queueOwnsMessage: true }),
    ],
    [
      'waiting_for_input promotes past an invalid delivery',
      steerRow({ status: 'waiting_for_input', deliveryValid: false }),
    ],
    ['rate_limit_cooldown promotes', steerRow({ status: 'rate_limit_cooldown' })],
    [
      'rate_limit_cooldown promotes ahead of ACP pending ownership',
      steerRow({ status: 'rate_limit_cooldown', provider: 'acp', queueOwnsMessage: true }),
    ],
    [
      'rate_limit_cooldown promotes past an invalid delivery',
      steerRow({ status: 'rate_limit_cooldown', deliveryValid: false }),
    ],
    ['interrupted promotes', steerRow({ status: 'interrupted' })],
    [
      'interrupted promotes ahead of ACP pending ownership',
      steerRow({ status: 'interrupted', provider: 'acp', queueOwnsMessage: true }),
    ],
    [
      'interrupted promotes past an invalid delivery',
      steerRow({ status: 'interrupted', deliveryValid: false }),
    ],
  ])('%s', (_label, input) => {
    expect(resolveSteerAdmission(input)).toEqual({ action: 'promote' });
  });
});

describe('classifyAcknowledgedSteer', () => {
  it.each([
    ['ACP awaits acceptance after the SDK ack', 'acp', 'awaiting_acceptance'],
    ['non-ACP settles consumed after the SDK ack', 'anthropic', 'consumed'],
  ])('%s', (_label, provider, expected) => {
    expect(classifyAcknowledgedSteer({ provider })).toBe(expected);
  });
});

describe('isSteerDeliveryValid', () => {
  it.each([
    ['an archived session invalidates even an enqueued row', true, 'enqueued', false],
    ['a missing delivery row is invalid', false, null, false],
    ['a consumed row is invalid for a steer', false, 'consumed', false],
    ['a submitted row is invalid for a steer', false, 'submitted', false],
    ['an enqueued row in a live session is valid', false, 'enqueued', true],
  ])('%s', (_label, sessionArchived, sendStatus, expected) => {
    expect(
      isSteerDeliveryValid({
        sessionArchived,
        row: sendStatus === null ? null : { content: 'steer-content', sendStatus },
      })
    ).toBe(expected);
  });
});

describe('planDeliveryRoleArbitration', () => {
  it.each([
    ['an active turn is reused over an implicit request', 'turn', undefined],
    ['an active turn is reused over a requested turn', 'turn', 'turn'],
    ['an active turn is reused over a requested steer', 'turn', 'steer'],
    ['an active steer is reused over an implicit request', 'steer', undefined],
    ['an active steer is reused over a requested turn', 'steer', 'turn'],
    ['an active steer is reused over a requested steer', 'steer', 'steer'],
  ])('%s', (_label, existingActiveRole, requestedRole) => {
    expect(planDeliveryRoleArbitration({ existingActiveRole, requestedRole })).toEqual({
      action: 'reuse',
      role: existingActiveRole,
    });
  });

  it.each([
    [
      'a fresh implicit delivery enqueues turn and converts a constraint hit to steer',
      { existingActiveRole: null },
      { action: 'enqueue', role: 'turn', uniqueConstraintFallback: 'steer' },
    ],
    [
      'an explicit turn enqueues without a constraint fallback',
      { existingActiveRole: null, requestedRole: 'turn' as const },
      { action: 'enqueue', role: 'turn', uniqueConstraintFallback: null },
    ],
    [
      'an explicit steer enqueues without a constraint fallback',
      { existingActiveRole: null, requestedRole: 'steer' as const },
      { action: 'enqueue', role: 'steer', uniqueConstraintFallback: null },
    ],
  ])('%s', (_label, input, expected) => {
    expect(planDeliveryRoleArbitration(input)).toEqual(expected);
  });
});

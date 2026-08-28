import { describe, expect, it } from 'bun:test';
import type { AgentProcessingState } from '@hyperneo/shared';
import type { SteerAdmissionDecision } from '../../../../src/lib/agent/delivery-turn-routing';
import { resolveSteerAdmission } from '../../../../src/lib/agent/delivery-turn-routing';

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

const DEFAULT_STATUSES = STATUSES.filter(
  (status) => status !== 'processing' && status !== 'queued'
);

const PROVIDERS = ['acp', 'anthropic', ''] as const;

function expectedSteerDecision(input: SteerInput): SteerAdmissionDecision {
  if (!input.claimCurrent) return { action: 'aborted', reason: 'claim_superseded' };
  if (input.status === 'processing') {
    if (!input.deliveryValid) return { action: 'aborted', reason: 'delivery_invalid' };
    if (!input.hasLiveQuery) return { action: 'promote' };
    if (input.provider === 'acp' && input.queueOwnsMessage) {
      return { action: 'awaiting_acceptance' };
    }
    return { action: 'feed' };
  }
  if (input.status === 'queued') return { action: 'park' };
  return { action: 'promote' };
}

function decisionKey(decision: SteerAdmissionDecision): string {
  return decision.action === 'aborted' ? `aborted:${decision.reason}` : decision.action;
}

function cellLabel(input: SteerInput): string {
  const verdict = decisionKey(expectedSteerDecision(input));
  return [
    `status=${input.status}`,
    `claim=${input.claimCurrent}`,
    `deliveryValid=${input.deliveryValid}`,
    `hasLiveQuery=${input.hasLiveQuery}`,
    `provider=${input.provider === '' ? 'unset' : input.provider}`,
    `queueOwnsMessage=${input.queueOwnsMessage}`,
    `-> ${verdict}`,
  ].join(' ');
}

const MATRIX: SteerInput[] = [];
for (const status of STATUSES) {
  for (const claimCurrent of [false, true]) {
    for (const deliveryValid of [false, true]) {
      for (const hasLiveQuery of [false, true]) {
        for (const provider of PROVIDERS) {
          for (const queueOwnsMessage of [false, true]) {
            MATRIX.push(
              steerRow({
                status,
                claimCurrent,
                deliveryValid,
                hasLiveQuery,
                provider,
                queueOwnsMessage,
              })
            );
          }
        }
      }
    }
  }
}

describe('resolveSteerAdmission full decision matrix', () => {
  it('enumerates the full cross product without duplicate cells', () => {
    const labels = MATRIX.map((input) => cellLabel(input));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.length).toBe(STATUSES.length * 2 * 2 * 2 * PROVIDERS.length * 2);
  });

  it.each(
    MATRIX.map((input) => [cellLabel(input), input, expectedSteerDecision(input)])
  )('%s', (_label, input, expected) => {
    expect(resolveSteerAdmission(input)).toEqual(expected);
  });

  it('the matrix reaches every admission action and both abort reasons', () => {
    const seen = [
      ...new Set(MATRIX.map((input) => decisionKey(resolveSteerAdmission(input)))),
    ].sort();
    expect(seen).toEqual(
      [
        'aborted:claim_superseded',
        'aborted:delivery_invalid',
        'awaiting_acceptance',
        'feed',
        'park',
        'promote',
      ].sort()
    );
  });
});

describe('resolveSteerAdmission processing sub-gate order', () => {
  it.each([
    [
      'an invalid delivery aborts ahead of the missing live query',
      steerRow({ deliveryValid: false, hasLiveQuery: false }),
      { action: 'aborted', reason: 'delivery_invalid' },
    ],
    [
      'an invalid delivery aborts ahead of ACP pending ownership',
      steerRow({ deliveryValid: false, provider: 'acp', queueOwnsMessage: true }),
      { action: 'aborted', reason: 'delivery_invalid' },
    ],
    [
      'a missing live query promotes ahead of ACP pending ownership',
      steerRow({ hasLiveQuery: false, provider: 'acp', queueOwnsMessage: true }),
      { action: 'promote' },
    ],
    [
      'ACP pending ownership awaits acceptance ahead of a fresh feed',
      steerRow({ provider: 'acp', queueOwnsMessage: true }),
      { action: 'awaiting_acceptance' },
    ],
    [
      'ACP without pending queue ownership still feeds',
      steerRow({ provider: 'acp', queueOwnsMessage: false }),
      { action: 'feed' },
    ],
    [
      'pending queue ownership under a non-ACP provider still feeds',
      steerRow({ provider: 'anthropic', queueOwnsMessage: true }),
      { action: 'feed' },
    ],
  ])('%s', (_label, input, expected) => {
    expect(resolveSteerAdmission(input)).toEqual(expected);
  });

  it('only the exact acp provider string takes the ACP admission path', () => {
    expect(resolveSteerAdmission(steerRow({ provider: 'acp', queueOwnsMessage: true }))).toEqual({
      action: 'awaiting_acceptance',
    });
    expect(
      resolveSteerAdmission(steerRow({ provider: 'anthropic', queueOwnsMessage: true }))
    ).toEqual({ action: 'feed' });
    expect(resolveSteerAdmission(steerRow({ provider: '', queueOwnsMessage: true }))).toEqual({
      action: 'feed',
    });
  });
});

describe('resolveSteerAdmission claim precedence', () => {
  it.each([
    [
      'a superseded claim aborts ahead of the processing delivery-validity gate',
      steerRow({ claimCurrent: false, deliveryValid: false }),
    ],
    [
      'a superseded claim aborts ahead of the missing live query',
      steerRow({ claimCurrent: false, hasLiveQuery: false }),
    ],
    [
      'a superseded claim aborts ahead of ACP pending ownership',
      steerRow({ claimCurrent: false, provider: 'acp', queueOwnsMessage: true }),
    ],
    [
      'a superseded claim aborts ahead of queued parking',
      steerRow({ claimCurrent: false, status: 'queued' }),
    ],
    [
      'a superseded claim aborts ahead of default promotion',
      steerRow({ claimCurrent: false, status: 'idle' }),
    ],
  ])('%s', (_label, input) => {
    expect(resolveSteerAdmission(input)).toEqual({ action: 'aborted', reason: 'claim_superseded' });
  });
});

describe('resolveSteerAdmission status dispatch', () => {
  it.each([
    [
      'queued parks ahead of the delivery-validity gate',
      steerRow({ status: 'queued', deliveryValid: false }),
    ],
    [
      'queued parks ahead of ACP pending ownership',
      steerRow({ status: 'queued', provider: 'acp', queueOwnsMessage: true }),
    ],
    [
      'queued parks with a valid delivery and no live query',
      steerRow({ status: 'queued', hasLiveQuery: false }),
    ],
  ])('%s', (_label, input) => {
    expect(resolveSteerAdmission(input)).toEqual({ action: 'park' });
  });

  it.each(
    DEFAULT_STATUSES.flatMap((status) => [
      [`${status} promotes a baseline steer`, steerRow({ status })],
      [
        `${status} promotes past invalid delivery, absent query, and ACP ownership`,
        steerRow({
          status,
          deliveryValid: false,
          hasLiveQuery: false,
          provider: 'acp',
          queueOwnsMessage: true,
        }),
      ],
    ])
  )('%s', (_label, input) => {
    expect(resolveSteerAdmission(input)).toEqual({ action: 'promote' });
  });
});

import { describe, expect, test } from 'bun:test';
import {
  declaredDutySources,
  deriveDuties,
  gateActiveHolder,
  gateDeclarersPresent,
  isDutyFallback,
  ownershipPatternSources,
  resolveDutyHolderId,
  resolveDutyHolders,
  type DutyDeclarer,
} from '../../../../src/lib/session-profile/duties.ts';

function declarer(overrides: Partial<DutyDeclarer> = {}): DutyDeclarer {
  return {
    agentId: 'agent-1',
    handle: 'agent-one',
    status: 'active',
    duties: ['goal_owner_fallback'],
    ...overrides,
  };
}

describe('deriveDuties', () => {
  test('maps a goal manager ownership pattern to the goal owner fallback duty', () => {
    expect(
      deriveDuties(ownershipPatternSources([{ target: 'goal', relationship: 'manager' }]))
    ).toEqual(['goal_owner_fallback']);
  });

  test('maps a goal owner ownership pattern to the goal owner fallback duty', () => {
    expect(
      deriveDuties(ownershipPatternSources([{ target: 'goal', relationship: 'owner' }]))
    ).toEqual(['goal_owner_fallback']);
  });

  test('maps declared escalation and review authority duties for non-space sessions', () => {
    expect(deriveDuties(declaredDutySources(['escalation', 'review_authority']))).toEqual([
      'escalation',
      'review_authority',
    ]);
  });

  test('ignores unrelated patterns and declared duties', () => {
    expect(
      deriveDuties([
        ...ownershipPatternSources([
          { target: 'goal', relationship: 'watcher' },
          { target: 'forge_scope', relationship: 'owner' },
        ]),
        ...declaredDutySources(['something_else']),
      ])
    ).toEqual([]);
  });

  test('returns no duties for missing sources', () => {
    expect(deriveDuties(undefined)).toEqual([]);
  });
});

describe('resolveDutyHolders', () => {
  test('assigns the active declarer of the duty', () => {
    const outcome = resolveDutyHolders({
      duty: 'goal_owner_fallback',
      declarers: [declarer()],
    });
    expect(!isDutyFallback(outcome) && outcome.holders.map((holder) => holder.agentId)).toEqual([
      'agent-1',
    ]);
  });

  test('reports no_declarer when nothing declares duties', () => {
    expect(resolveDutyHolders({ duty: 'escalation', declarers: [] })).toBe('no_declarer');
  });

  test('reports no_active_holder when the only declarer is not active', () => {
    expect(
      resolveDutyHolders({
        duty: 'goal_owner_fallback',
        declarers: [declarer({ status: 'paused' })],
      })
    ).toBe('no_active_holder');
  });

  test('ignores declarers of a different duty', () => {
    expect(resolveDutyHolders({ duty: 'escalation', declarers: [declarer()] })).toBe(
      'no_active_holder'
    );
  });

  test('orders holders deterministically by handle then agent id', () => {
    const outcome = resolveDutyHolders({
      duty: 'goal_owner_fallback',
      declarers: [
        declarer({ agentId: 'agent-c', handle: 'zulu' }),
        declarer({ agentId: 'agent-b', handle: 'alpha' }),
        declarer({ agentId: 'agent-a', handle: null }),
      ],
    });
    expect(!isDutyFallback(outcome) && outcome.holders.map((holder) => holder.agentId)).toEqual([
      'agent-a',
      'agent-b',
      'agent-c',
    ]);
  });
});

describe('duty gates', () => {
  test('gateDeclarersPresent halts on an empty declarer list', () => {
    expect(gateDeclarersPresent({ duty: 'escalation', declarers: [] })).toEqual({
      reason: 'no_declarer',
    });
  });

  test('gateActiveHolder halts when no active holder exists', () => {
    expect(gateActiveHolder({ duty: 'escalation', declarers: [declarer()] })).toEqual({
      reason: 'no_active_holder',
    });
  });
});

describe('resolveDutyHolderId', () => {
  test('returns the primary holder id', () => {
    expect(resolveDutyHolderId({ duty: 'goal_owner_fallback', declarers: [declarer()] })).toBe(
      'agent-1'
    );
  });

  test('returns null when there is no active holder', () => {
    expect(
      resolveDutyHolderId({
        duty: 'goal_owner_fallback',
        declarers: [declarer({ status: 'paused' })],
      })
    ).toBeNull();
  });
});

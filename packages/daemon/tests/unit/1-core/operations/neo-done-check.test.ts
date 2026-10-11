import { describe, expect, test } from 'bun:test';
import {
  neoDoneCheckToldIds,
  requireNeoDoneCheck,
  requireNeoDoneCheckDue,
  requireNeoDoneCheckUntold,
  neoWorkReturnToldIds,
  requireNeoWorkReturnUntold,
} from '../../../../src/lib/neo/done-check.ts';
import type { NeoEvidence } from '../../../../src/lib/neo/evidence.ts';

const goal = { workId: 'w1', goal: 'Fix it', doneWhen: '- merged' };
const card = { goal, driver: true, session: true, ask: { status: 'open' as const } };

describe('requireNeoDoneCheck', () => {
  test.each<
    [
      string,
      string,
      Partial<Omit<typeof card, 'ask'>> & { ask?: { status: 'open' } | null },
      boolean,
    ]
  >([
    ['a reported driver card with a done list', 'reported', {}, true],
    ['a card still running', 'queued', {}, false],
    ['a card with no done list', 'reported', { goal: { ...goal, doneWhen: '' } }, false],
    ['a card that is not driver work', 'reported', { driver: false }, false],
    ['a card whose Neo session is gone', 'reported', { session: false }, false],
    ['a card with no ask', 'reported', { ask: null }, false],
  ])('%s', (_label, status, overrides, checks) => {
    const gate = requireNeoDoneCheck({ status: status as 'reported' }, { ...card, ...overrides });
    expect(gate).toEqual(checks ? { value: goal } : { reason: 'not_checked' });
  });

  test.each(['achieved', 'abandoned'] as const)(
    'stays quiet for a card whose ask is %s',
    (status) => {
      expect(requireNeoDoneCheck({ status: 'reported' }, { ...card, ask: { status } })).toEqual({
        reason: 'settled',
      });
    }
  );

  test('still lets failed work under a settled ask send its plain return note', () => {
    expect(
      requireNeoDoneCheck({ status: 'failed' }, { ...card, ask: { status: 'achieved' } })
    ).toEqual({ reason: 'not_checked' });
  });
});

describe('neoDoneCheckToldIds', () => {
  test.each<[string, number | undefined, boolean, string[]]>([
    ['a first check', undefined, false, ['w1:done-check:2', 'w1:done-check:2:at:900']],
    [
      'a check with pull requests',
      3,
      false,
      ['w1:done-check:2:pr:3', 'w1:done-check:2:pr:3:at:900'],
    ],
    ['a follow-up', 3, true, ['w1:done-check:2:pr:3:at:900']],
  ])('%s', (_label, revision, followed, ids) => {
    expect(neoDoneCheckToldIds({ id: 'w1', updatedAt: 900 }, 2, revision, followed)).toEqual(ids);
  });
});

describe('neoWorkReturnToldIds', () => {
  const work = { id: 'w1', updatedAt: 50 };
  test.each([
    [
      'a fresh card',
      { retries: 0, continued: 0, prRevision: undefined },
      ['w1', 'w1:done-check:0', 'w1:done-check:0:at:50'],
    ],
    [
      'a continued card with a pull request',
      { retries: 0, continued: 1, prRevision: 2 },
      [
        'w1:continued:1',
        'w1:done-check:1',
        'w1:done-check:1:at:50',
        'w1:done-check:1:pr:2',
        'w1:done-check:1:pr:2:at:50',
      ],
    ],
  ])('%s is told by its current ids only', (_name, card, ids) => {
    expect(neoWorkReturnToldIds(work, card)).toEqual(ids);
  });

  test('told at continue 0 does not count as told at continue 1', () => {
    const toldBefore = new Set(
      neoWorkReturnToldIds(work, { retries: 0, continued: 0, prRevision: undefined })
    );
    expect(
      neoWorkReturnToldIds(work, { retries: 0, continued: 1, prRevision: undefined }).some((id) =>
        toldBefore.has(id)
      )
    ).toBe(false);
  });
});

describe('requireNeoWorkReturnUntold', () => {
  test('recovery returns only an untold report', () => {
    expect(requireNeoWorkReturnUntold({ told: false })).toEqual({ value: true });
    expect(requireNeoWorkReturnUntold({ told: true })).toEqual({ reason: 'told' });
  });
});

describe('requireNeoDoneCheckUntold', () => {
  test.each<[string, boolean, ReturnType<typeof requireNeoDoneCheckUntold<string>>]>([
    ['a check not sent yet', false, { value: 'goal' }],
    ['a check Neo already has', true, { reason: 'told' }],
  ])('%s', (_label, told, gate) => {
    expect(requireNeoDoneCheckUntold({ told }, 'goal')).toEqual(gate);
  });
});

describe('requireNeoDoneCheckDue', () => {
  const evidence = (state: NeoEvidence['state']): NeoEvidence => ({
    key: 'k',
    state,
    summary: state,
    blockers: [],
  });
  test.each<
    [string, { evidence: NeoEvidence[] } | null, ReturnType<typeof requireNeoDoneCheckDue<string>>]
  >([
    ['no evidence read', null, { value: 'goal' }],
    ['evidence still waiting', { evidence: [evidence('waiting')] }, { reason: 'waiting' }],
    ['evidence ready', { evidence: [evidence('ready')] }, { value: 'goal' }],
  ])('%s', (_label, read, gate) => {
    expect(requireNeoDoneCheckDue({ read }, 'goal')).toEqual(gate);
  });
});

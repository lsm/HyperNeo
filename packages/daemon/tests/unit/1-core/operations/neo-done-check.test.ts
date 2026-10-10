import { describe, expect, test } from 'bun:test';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import {
  neoDoneCheckToldIds,
  requireNeoDoneCheck,
  requireNeoDoneCheckDue,
  requireNeoDoneCheckUntold,
} from '../../../../src/lib/neo/done-check.ts';

const goal = { workId: 'w1', goal: 'Fix it', doneWhen: '- merged' };
const card = { goal, driver: true, session: true };
const pr: NeoWorkPr = {
  url: 'https://github.com/lsm/HyperNeo/pull/1',
  state: 'OPEN',
  checks: 'pending',
  review: 'none',
};

describe('requireNeoDoneCheck', () => {
  test.each<[string, string, Partial<typeof card>, boolean]>([
    ['a reported driver card with a done list', 'reported', {}, true],
    ['a card still running', 'queued', {}, false],
    ['a card with no done list', 'reported', { goal: { ...goal, doneWhen: '' } }, false],
    ['a card that is not driver work', 'reported', { driver: false }, false],
    ['a card whose Neo session is gone', 'reported', { session: false }, false],
  ])('%s', (_label, status, overrides, checks) => {
    const gate = requireNeoDoneCheck({ status: status as 'reported' }, { ...card, ...overrides });
    expect(gate).toEqual(checks ? { value: goal } : { reason: false });
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

describe('requireNeoDoneCheckUntold', () => {
  test.each<[string, boolean, ReturnType<typeof requireNeoDoneCheckUntold<string>>]>([
    ['a check not sent yet', false, { value: 'goal' }],
    ['a check Neo already has', true, { reason: true }],
  ])('%s', (_label, told, gate) => {
    expect(requireNeoDoneCheckUntold({ told }, 'goal')).toEqual(gate);
  });
});

describe('requireNeoDoneCheckDue', () => {
  test.each<
    [string, { prs: NeoWorkPr[] } | null, ReturnType<typeof requireNeoDoneCheckDue<string>>]
  >([
    ['no pull requests', null, { value: 'goal' }],
    ['a pull request still running CI', { prs: [pr] }, { reason: true }],
    [
      'a pull request with green checks',
      { prs: [{ ...pr, checks: 'passing' }] },
      { value: 'goal' },
    ],
  ])('%s', (_label, row, gate) => {
    expect(requireNeoDoneCheckDue({ row }, 'goal')).toEqual(gate);
  });
});

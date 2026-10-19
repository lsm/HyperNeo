import { describe, expect, test } from 'bun:test';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { isNeoCardPrRoutine } from '../../../../src/lib/neo/card-wake.ts';

const pr = (extra: Partial<NeoWorkPr> = {}): NeoWorkPr => ({
  url: 'https://github.com/o/r/pull/1',
  state: 'OPEN',
  checks: 'passing',
  review: 'none',
  ...extra,
});

describe('isNeoCardPrRoutine', () => {
  test.each<[string, Partial<NeoWorkPr>, boolean]>([
    ['CI running', { checks: 'pending' }, true],
    ['green and waiting for a review', {}, true],
    ['green, no checks, waiting for a review', { checks: 'none' }, true],
    ['only a required approval missing', { blockers: ['needs 1 approving review, has 0'] }, true],
    ['failing CI', { checks: 'failing' }, false],
    ['approved', { review: 'approved' }, false],
    ['changes requested', { review: 'changes_requested' }, false],
    ['conflicts', { blockers: ['merge conflicts with dev'] }, false],
    ['an unresolved thread', { blockers: ['1 unresolved review thread'] }, false],
    ['merged', { state: 'MERGED' }, false],
  ])('%s', (_label, extra, routine) => {
    expect(isNeoCardPrRoutine(pr(extra))).toBe(routine);
  });
});

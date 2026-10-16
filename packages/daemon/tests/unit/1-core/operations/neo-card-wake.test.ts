import { isNeoCardPrAwaited } from '../../../../src/lib/neo/packs/coding/card-facts.ts';
import { describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import {
  isNeoCardAwaitingPr,
  isNeoCardDoneWhenMet,
  isNeoCardPrRoutine,
  isNeoHumanInputSince,
  neoCardWakeProgress,
  neoContinueFacts,
} from '../../../../src/lib/neo/card-wake.ts';
import { NeoWorkWakeRepository } from '../../../../src/storage/repositories/neo-work-wake-repository.ts';
import { runMigration353 } from '../../../../src/storage/schema/m353-neo-work-wakes.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const pr = (extra: Partial<NeoWorkPr> = {}): NeoWorkPr => ({
  url: 'https://github.com/o/r/pull/1',
  state: 'OPEN',
  checks: 'passing',
  review: 'none',
  ...extra,
});
const items = (...states: ('met' | 'pending')[]) =>
  ({
    doneItems: states.map((state, index) => ({ id: `i${index}`, text: 't', state })),
  }) as unknown as Pick<NeoAsk, 'doneItems'>;

describe('neoCardWakeProgress', () => {
  test('moves when an item is ticked met, not only with the card', () => {
    expect(neoCardWakeProgress('0|a', items('pending'))).toBe('0|a|0');
    expect(neoCardWakeProgress('0|a', items('met'))).toBe('0|a|1');
    expect(neoCardWakeProgress('0|a', null)).toBe('0|a|0');
  });
});

describe('isNeoHumanInputSince', () => {
  test('counts only a human message after the last continue', () => {
    expect(isNeoHumanInputSince(null, 10)).toBe(false);
    expect(isNeoHumanInputSince(10, 10)).toBe(false);
    expect(isNeoHumanInputSince(11, 10)).toBe(true);
  });
});

describe('isNeoCardPrAwaited', () => {
  test.each<[string, Partial<NeoWorkPr>, boolean]>([
    ['pending CI', { checks: 'pending' }, true],
    ['only a missing approval', { blockers: ['needs 1 approving review, has 0'] }, true],
    ['failing CI', { checks: 'failing' }, false],
    ['changes requested', { review: 'changes_requested' }, false],
    ['an unresolved thread', { blockers: ['1 unresolved review thread'] }, false],
    [
      'a conflict next to the missing approval',
      { blockers: ['needs 1 approving review, has 0', 'merge conflicts with dev'] },
      false,
    ],
    ['clean and unreviewed with nothing blocking', {}, false],
    ['merged', { state: 'MERGED', checks: 'pending' }, false],
  ])('%s', (_name, extra, awaited) => {
    expect(isNeoCardPrAwaited(pr(extra))).toBe(awaited);
  });
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

describe('isNeoCardAwaitingPr', () => {
  test('a card waits only when every open PR is routine', () => {
    expect(isNeoCardAwaitingPr([])).toBe(false);
    expect(isNeoCardAwaitingPr([pr({ state: 'MERGED' })])).toBe(false);
    expect(isNeoCardAwaitingPr([pr({ state: 'MERGED' }), pr({ checks: 'pending' })])).toBe(true);
    expect(isNeoCardAwaitingPr([pr(), pr({ checks: 'failing' })])).toBe(false);
  });
});

describe('isNeoCardDoneWhenMet', () => {
  test('a card closed as done, or an ask whose every item is met', () => {
    expect(isNeoCardDoneWhenMet({ report: 'Closed as done by Neo: merged.' }, null)).toBe(true);
    expect(isNeoCardDoneWhenMet({ report: 'Working.' }, items('met', 'met'))).toBe(true);
    expect(isNeoCardDoneWhenMet({ report: 'Working.' }, items('met', 'pending'))).toBe(false);
    expect(isNeoCardDoneWhenMet({ report: null }, items())).toBe(false);
  });
});

describe('NeoWorkWakeRepository', () => {
  function repo() {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_work (id TEXT PRIMARY KEY)');
    db.exec("INSERT INTO neo_work VALUES ('w1')");
    runMigration353(db);
    runMigration353(db);
    return new NeoWorkWakeRepository(db);
  }

  test('three wakes without progress stall; progress or human input starts over', () => {
    const wakes = repo();
    wakes.recordWake('w1', 'n1', 'p', 1);
    wakes.recordWake('w1', 'n2', 'p', 2);
    wakes.recordWake('w1', 'n3', 'p', 3);
    expect(wakes.recordWake('w1', 'n4', 'p', 4)).toMatchObject({ wakes: 4, stalled: 0 });
    expect(wakes.recordWake('w1', 'n5', 'q', 5)).toMatchObject({ wakes: 5, stalled: 0 });
    wakes.recordWake('w1', 'n6', 'q', 6);
    expect(wakes.recordContinue('w1', 'q', true)).toMatchObject({
      stalled: 0,
      continuedWake: 6,
    });
  });

  test('the same note twice is one wake, and a continue alone moves nothing', () => {
    const wakes = repo();
    wakes.recordWake('w1', 'n1', 'p', 1);
    expect(wakes.recordWake('w1', 'n1', 'p', 9)).toMatchObject({ wakes: 1, stalled: 0, wokeAt: 1 });
    wakes.recordWake('w1', 'n2', 'p', 2);
    expect(wakes.recordContinue('w1', 'other', false)).toMatchObject({
      wakes: 2,
      stalled: 0,
      progress: 'p',
      continuedWake: 2,
    });
  });

  test('a continue before any wake starts the row at wake zero', () => {
    expect(repo().recordContinue('w1', 'p', false)).toMatchObject({
      wakes: 0,
      stalled: 0,
      continuedWake: 0,
    });
  });
});

describe('neoContinueFacts', () => {
  test('returns waits, completed outcomes and prior sends as facts without refusing', () => {
    expect(
      neoContinueFacts(
        {
          guarded: true,
          human: false,
          doneWhenMet: true,
          prs: [pr({ checks: 'pending' })],
          wake: null,
        },
        {
          workId: 'w1',
          count: 500,
          continuedAt: 1,
          lastMessage: 'Next',
          progress: 'p1',
          stalled: 100,
        }
      )
    ).toMatchObject({
      done_when_met: true,
      prior_sends: 500,
      progress: 'p1',
      last_send: { at: 1, message: 'Next' },
    });
  });
});

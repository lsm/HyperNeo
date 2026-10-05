import { describe, expect, test } from 'bun:test';
import { combineFindResults, fitFindBudget } from '../../../../src/lib/drivers/find-operation';
import type { PlaceGroup } from '../../../../src/lib/drivers/types';

function place(name: string, titles: string[]): PlaceGroup {
  const where = { machine: 'imac', folder: `/focus/${name}`, name };
  return {
    place: where,
    lastActivityAt: titles.length,
    openCount: titles.length,
    archivedCount: 0,
    adapters: ['hyperneo'],
    work: titles.map((title, index) => ({
      ref: { adapter: 'hyperneo', id: `${name}-${index}` },
      title,
      place: where,
      status: 'running',
      lastActivityAt: index,
    })),
  };
}

describe('fitFindBudget', () => {
  test('keeps everything that fits and says nothing was left out', () => {
    const places = [place('a', ['one', 'two'])];
    expect(fitFindBudget(places, 10_000)).toEqual({ places, more: false });
  });

  test('stops adding work at the budget and flags more', () => {
    const places = [place('a', ['x'.repeat(150), 'y'.repeat(150)]), place('b', ['z'])];
    const fitted = fitFindBudget(places, 700);
    expect(fitted.more).toBe(true);
    expect(fitted.places.map((g) => [g.place.name, g.work.length])).toEqual([['a', 1]]);
    expect(JSON.stringify(fitted.places).length).toBeLessThanOrEqual(700);
  });

  test('cuts a runaway title to 200 characters', () => {
    const [group] = fitFindBudget([place('a', ['t'.repeat(5_000)])], 10_000).places;
    expect(group.work[0].title).toBe(`${'t'.repeat(200)}…`);
  });
});

describe('combineFindResults', () => {
  test('flags more when there are more places than the limit', () => {
    const local = { groups: [place('a', ['one']), place('b', ['two'])], unreachable: [] };
    const input = { includeClosed: false, limit: 1, localOnly: false };
    const result = combineFindResults(local, { groups: [], unreachable: [] }, input);
    expect([result.places.length, result.more]).toEqual([1, true]);
    expect(
      combineFindResults(local, { groups: [], unreachable: [] }, { ...input, limit: 5 }).more
    ).toBe(false);
  });
});

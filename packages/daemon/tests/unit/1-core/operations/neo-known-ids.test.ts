import { describe, expect, test } from 'bun:test';
import { neoKnownIds } from '../../../../src/lib/neo/known-ids.ts';

describe('neoKnownIds', () => {
  test('lists ids with short titles, and says when there are none', () => {
    expect(neoKnownIds('open items', [])).toBe('There are no open items.');
    expect(
      neoKnownIds('live asks you opened', [
        { id: 'a1', title: '  Plan\nthe   pond ' },
        { id: 'a2', title: 'x'.repeat(80) },
        { id: 'a3' },
      ])
    ).toBe(`Use one of the live asks you opened: a1 "Plan the pond"; a2 "${'x'.repeat(49)}…"; a3.`);
  });

  test('shows twelve and counts the rest', () => {
    const known = Array.from({ length: 15 }, (_, i) => ({ id: `w${i}`, title: `Card ${i}` }));
    const text = neoKnownIds('cards on your live asks', known);
    expect(text).toContain('w11 "Card 11"; 3 more.');
    expect(text).not.toContain('w12');
  });
});

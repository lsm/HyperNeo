import { describe, expect, test } from 'bun:test';
import { fitLines } from '../../../../src/lib/neo/fit-lines.ts';

describe('fitLines', () => {
  test.each([
    ['keeps every line within the budget', ['ab', 'cd'], 6, 0, ['ab', 'cd']],
    ['stops at the first line that overflows', ['ab', 'cdef', 'g'], 6, 0, ['ab']],
    ['counts what is already used', ['ab', 'cd'], 6, 3, ['ab']],
    ['keeps nothing when the first line overflows', ['abcdef'], 6, 0, []],
  ] as const)('%s', (_label, lines, budget, used, expected) => {
    expect(fitLines(lines, budget, used)).toEqual([...expected]);
  });
});

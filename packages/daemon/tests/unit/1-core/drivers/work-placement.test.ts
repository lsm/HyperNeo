import { describe, expect, test } from 'bun:test';
import { planWorkPlacement } from '../../../../src/lib/drivers/work-placement';

describe('planWorkPlacement', () => {
  test.each([
    ['a plain folder runs in place', null, { kind: 'in_place' }],
    ['a linked worktree runs in place', { repo: '/r', linked: true }, { kind: 'in_place' }],
    [
      'a main checkout gets its own worktree',
      { repo: '/r', linked: false },
      { kind: 'worktree', repo: '/r' },
    ],
  ] as const)('%s', (_label, checkout, expected) => {
    expect(planWorkPlacement(checkout)).toEqual(expected);
  });
});

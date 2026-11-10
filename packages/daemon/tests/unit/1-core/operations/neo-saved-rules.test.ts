import { describe, expect, test } from 'bun:test';
import { planNeoRuleEdit } from '../../../../src/lib/neo/saved-rules.ts';

describe('planNeoRuleEdit', () => {
  test('keeps at most twenty rules, but removal always works', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `Rule ${i}.`);
    expect(planNeoRuleEdit(twenty, { add: ['Another.'] })).toMatchObject({
      reason: { ok: false, reason: 'At most 20 rules are kept; remove one first.' },
    });
    expect(planNeoRuleEdit(twenty, { add: ['Another.'], remove: [twenty[0]] })).toEqual({
      value: [...twenty.slice(1), 'Another.'],
    });
    const over = Array.from({ length: 25 }, (_, i) => `Rule ${i}.`);
    expect(planNeoRuleEdit(over, { remove: [over[0]] })).toEqual({ value: over.slice(1) });
  });
  test.each([
    ['adding one rule keeps the others', ['A.', 'B.'], { add: ['C.'] }, ['A.', 'B.', 'C.']],
    ['removing one rule keeps the others', ['A.', 'B.', 'C.'], { remove: ['B.'] }, ['A.', 'C.']],
    [
      'a replaced rule takes the removed one’s place at the end',
      ['A.', 'B.'],
      { add: ['B2.'], remove: ['B.'] },
      ['A.', 'B2.'],
    ],
    ['an existing rule is not added twice', ['A.'], { add: ['A.', 'B.', 'B.'] }, ['A.', 'B.']],
  ])('%s', (_label, current, edit, rules) => {
    expect(planNeoRuleEdit(current, edit)).toEqual({ value: rules });
  });

  test.each([
    ['an empty edit', ['A.'], {}, 'Name a rule to add or remove.'],
    ['removing a rule that is not saved', ['A.'], { remove: ['Z.'] }, '"Z." is not a saved rule'],
  ])('refuses %s', (_label, current, edit, reason) => {
    expect(planNeoRuleEdit(current, edit)).toMatchObject({
      reason: { ok: false, reason: expect.stringContaining(reason) },
    });
  });
});

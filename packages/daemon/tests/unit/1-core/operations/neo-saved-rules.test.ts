import { describe, expect, test } from 'bun:test';
import { planNeoRuleEdit } from '../../../../src/lib/neo/saved-rules.ts';

describe('planNeoRuleEdit', () => {
  test('keeps every rule beyond twenty', () => {
    const rules = Array.from({ length: 25 }, (_, i) => `Rule ${i}.`);
    expect(planNeoRuleEdit(rules, { add: ['Another.'] })).toEqual({ value: [...rules, 'Another.'] });
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

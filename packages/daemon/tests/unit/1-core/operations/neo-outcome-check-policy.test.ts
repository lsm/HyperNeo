import { describe, expect, test } from 'bun:test';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { neoOutcomeBindingPolicy } from '../../../../src/lib/neo/outcome-binding-policy';
import { neoOutcomeCheckPolicy } from '../../../../src/lib/neo/outcome-check-policy';

describe('neoOutcomeCheckPolicy', () => {
  test.each([
    'no merge or deployment',
    'Merged to dev',
    'PR #42 is merged',
    'Deployed to both daemons',
    'Merge CSV files into one report',
    'A pull request is open, not merged yet',
  ])('never demands a check from the words in %j', (text) => {
    const items = [{ text }];
    expect(neoOutcomeCheckPolicy.requireChecks(items)).toEqual({ value: items });
  });

  test('accepts the checks an outcome carries and preserves the original immutable items', () => {
    const items = Object.freeze([
      Object.freeze({ text: 'Merged to dev', check: 'coding.pr_merged', id: 'merge' }),
      Object.freeze({ text: 'Deployed', check: 'coding.deployed', id: 'deploy' }),
      Object.freeze({ text: 'A pull request is open', check: 'coding.pr_opened', id: 'open' }),
      Object.freeze({ text: 'Design chosen', check: null, id: 'design' }),
    ]);
    const result = neoOutcomeCheckPolicy.requireChecks(items);
    expect(result).toEqual({ value: items });
    if (!('value' in result)) throw new Error('unexpected refusal');
    expect(result.value).toBe(items);
  });

  test('an opened check is refused on an item bound to a card', () => {
    const result = neoOutcomeCheckPolicy.requireChecks([
      { text: 'A pull request is open', check: 'coding.pr_opened', deliveredBy: 'card-a' },
    ]);
    if (!('reason' in result)) throw new Error('expected refusal');
    expect(result.reason.reason).toContain('opened_check_unbound');
  });
});

describe('neoOutcomeBindingPolicy', () => {
  const ask = (check: string) =>
    ({
      id: 'a1',
      status: 'open',
      revision: 0,
      workIds: ['card-a'],
      doneItems: [{ id: 'i1', text: 'A pull request is open', state: 'pending', check }],
    }) as unknown as NeoAsk;
  const cards = [{ id: 'card-a', dispatched: false }];
  test('refuses binding an opened-check item to a card, and allows unbinding it', () => {
    const bind = [{ itemId: 'i1', deliveredBy: 'card-a' }];
    expect(neoOutcomeBindingPolicy.requireBindings(ask('coding.pr_opened'), bind, cards)).toEqual({
      reason: { ok: false, reason: 'opened_check_unbound' },
    });
    expect(
      'value' in neoOutcomeBindingPolicy.requireBindings(ask('coding.pr_merged'), bind, cards)
    ).toBe(true);
    expect(
      'value' in
        neoOutcomeBindingPolicy.requireBindings(
          ask('coding.pr_opened'),
          [{ itemId: 'i1', deliveredBy: null }],
          cards
        )
    ).toBe(true);
  });
});

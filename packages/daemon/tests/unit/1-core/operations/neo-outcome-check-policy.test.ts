import { describe, expect, test } from 'bun:test';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { neoOutcomeBindingPolicy } from '../../../../src/lib/neo/outcome-binding-policy';
import { neoOutcomeCheckPolicy } from '../../../../src/lib/neo/outcome-check-policy';

describe('neoOutcomeCheckPolicy', () => {
  test.each([
    ['Merged to dev', 'coding.pr_merged'],
    ['PR #42 is merged', 'coding.pr_merged'],
    ['The pull request is merged', 'coding.pr_merged'],
    ['https://github.com/lsm/HyperNeo/pull/42 merged', 'coding.pr_merged'],
    ['Merging into dev', 'coding.pr_merged'],
    ['Merge into the target branch', 'coding.pr_merged'],
    ['Slice 6 deployed to both daemons', 'coding.deployed'],
    ['Rolled out on the laptop', 'coding.deployed'],
    ['Every daemon runs the latest commit', 'coding.deployed'],
    ['Merged and deployed to both daemons', 'coding.deployed'],
    ['User selects the design', null],
    ['Merge CSV files into one report', null],
    ['Merged the CSV exports', null],
    ['Merged the two services', null],
    ['The contact records were merged', null],
    ['CI green', null],
    ['Deployed to TestFlight on the iPhone', null],
  ])('classifies %s as %s', (text, check) => {
    expect(neoOutcomeCheckPolicy.requiredCheck({ text })).toBe(check);
  });
  test.each([undefined, null, 'life-admin.confirmed', 'coding.pr_merged'])(
    'requires the deploy check instead of %s',
    (check) => {
      const result = neoOutcomeCheckPolicy.requireChecks([{ text: 'Deployed', check }]);
      expect(result).toMatchObject({ reason: { ok: false } });
      if (!('reason' in result)) throw new Error('expected refusal');
      expect(result.reason.reason).toContain('requires check coding.deployed');
    }
  );
  test('rejects a watched merge without its matching check and reports every missing check', () => {
    const result = neoOutcomeCheckPolicy.requireChecks([
      { text: 'PR merged', watch: ['https://github.com/lsm/HyperNeo/pull/42'] },
      { text: 'Deployed to both daemons' },
    ]);
    if (!('reason' in result)) throw new Error('expected refusal');
    expect(result.reason.reason).toContain('coding.pr_merged');
    expect(result.reason.reason).toContain('coding.deployed');
  });
  test('an opened check never stands in for a merged, tested or deployed outcome', () => {
    for (const text of [
      'PR merged to dev',
      'Deployed to both daemons',
      'Fix merged',
      'CI green',
      'Released to users',
      'Tests pass',
    ]) {
      const result = neoOutcomeCheckPolicy.requireChecks([{ text, check: 'coding.pr_opened' }]);
      if (!('reason' in result)) throw new Error('expected refusal');
      expect(result.reason.reason).toContain('opened_check_too_weak');
    }
    const opened = [{ text: 'A pull request is open in lsm/HyperNeo', check: 'coding.pr_opened' }];
    expect(neoOutcomeCheckPolicy.requireChecks(opened)).toEqual({ value: opened });
  });

  test('an opened check is refused on an item bound to a card', () => {
    const result = neoOutcomeCheckPolicy.requireChecks([
      { text: 'A pull request is open', check: 'coding.pr_opened', deliveredBy: 'card-a' },
    ]);
    if (!('reason' in result)) throw new Error('expected refusal');
    expect(result.reason.reason).toContain('opened_check_too_weak');
  });
  test('accepts correct checks and preserves the original immutable items', () => {
    const items = Object.freeze([
      Object.freeze({ text: 'Merged to dev', check: 'coding.pr_merged', id: 'merge' }),
      Object.freeze({ text: 'Deployed', check: 'coding.deployed', id: 'deploy' }),
      Object.freeze({ text: 'Design chosen', check: null, id: 'design' }),
    ]);
    const result = neoOutcomeCheckPolicy.requireChecks(items);
    expect(result).toEqual({ value: items });
    if (!('value' in result)) throw new Error('unexpected refusal');
    expect(result.value).toBe(items);
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

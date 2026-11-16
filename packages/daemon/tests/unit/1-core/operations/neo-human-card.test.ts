import { describe, expect, test } from 'vitest';
import { requireHumanCard } from '../../../../src/lib/neo/human-card.ts';

const draft = (text: string, kind: 'reply' | 'yesno' | 'choice' = 'yesno') => ({
  text,
  kind,
  noLabel: 'No',
  yesLabel: 'Yes',
  options: null,
  multiple: false,
});
const reason = (gate: ReturnType<typeof requireHumanCard>) =>
  'reason' in gate ? gate.reason.reason : null;

describe('requireHumanCard', () => {
  test('a plain question with buttons passes', () => {
    expect(reason(requireHumanCard(draft('Ship it?'), undefined))).toBeNull();
  });

  test('a reply card must ask something', () => {
    expect(reason(requireHumanCard(draft('Report ready.', 'reply'), undefined))).toMatch(
      /^card_no_action/
    );
    expect(reason(requireHumanCard(draft('发到哪里？', 'reply'), undefined))).toBeNull();
  });

  test('long text belongs in the document', () => {
    expect(reason(requireHumanCard(draft(`${'a'.repeat(400)}?`), undefined))).toMatch(
      /^card_too_long/
    );
    expect(reason(requireHumanCard(draft(`${'a'.repeat(399)}?`), undefined))).toBeNull();
  });

  test('internal ids stay off the card, except a home proposal that must show its hash', () => {
    for (const id of [
      '44fe354',
      '44fe3547',
      '44fe3547-0fec-4428-920c-a4614ddac82b',
      '594914c7d5e05615ff1d7d9d327d07875d613b46',
    ])
      expect(reason(requireHumanCard(draft(`Card ${id} ok?`), undefined))).toMatch(
        /^card_internal_id/
      );
    expect(reason(requireHumanCard(draft('Merge #9930 for 12345678?'), undefined))).toBeNull();
    expect(reason(requireHumanCard(draft('Was it defaced?'), undefined))).toBeNull();
    const confirm = { path: 'a', sha256: 'b' } as never;
    expect(reason(requireHumanCard({ ...draft('Save 44fe3547?'), confirm }, undefined))).toBeNull();
  });

  test('a set language is enforced; an unset or system language is not', () => {
    expect(reason(requireHumanCard(draft('Ship it?'), 'zh-Hans'))).toMatch(/^card_language/);
    expect(reason(requireHumanCard(draft('现在发布吗?'), 'zh-Hans'))).toBeNull();
    expect(reason(requireHumanCard(draft('现在发布吗?'), 'en'))).toMatch(/^card_language/);
    expect(reason(requireHumanCard(draft('Ship #9930 现在?'), 'en'))).toBeNull();
    for (const language of ['system', undefined] as const)
      expect(reason(requireHumanCard(draft('现在发布吗?'), language))).toBeNull();
  });
});

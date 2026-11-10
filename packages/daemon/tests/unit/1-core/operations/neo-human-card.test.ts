import { describe, expect, test } from 'vitest';
import type { NeoQuestion } from '@hyperneo/shared/types/neo-ask';
import { requireHumanCard } from '../../../../src/lib/neo/human-card.ts';

const draft = (text: string, kind: 'reply' | 'yesno' | 'choice' = 'yesno') => ({
  text,
  kind,
  noLabel: 'No',
  yesLabel: 'Yes',
  options: null,
  multiple: false,
  startTodos: null,
});
const open = (id: string, kind = 'yesno', text = 'Ship it?') =>
  ({ id, kind, text, state: 'open', todoId: 'todo' }) as NeoQuestion;
const reason = (gate: ReturnType<typeof requireHumanCard>) =>
  'reason' in gate ? gate.reason.reason : null;

describe('requireHumanCard', () => {
  test('a plain question with buttons passes', () => {
    expect(reason(requireHumanCard(draft('Ship it?'), [], null, undefined))).toBeNull();
  });

  test('a reply card must ask something', () => {
    expect(reason(requireHumanCard(draft('Report ready.', 'reply'), [], null, undefined))).toMatch(
      /^card_no_action/
    );
    expect(reason(requireHumanCard(draft('发到哪里？', 'reply'), [], null, undefined))).toBeNull();
  });

  test('one open card per ask, unless this one replaces it', () => {
    const prior = open('prior-card');
    expect(reason(requireHumanCard(draft('Ship it?'), [prior], null, undefined))).toMatch(
      /^card_open/
    );
    expect(reason(requireHumanCard(draft('Ship it?'), [prior], prior, undefined))).toBeNull();
    expect(
      reason(requireHumanCard(draft('Ship it?'), [open('s', 'start')], null, undefined))
    ).toBeNull();
    expect(
      reason(
        requireHumanCard(draft('Ship it?'), [{ ...prior, state: 'answered' }], null, undefined)
      )
    ).toBeNull();
  });

  test('a fixed daemon proposal does not block the next card', () => {
    const proposal = { ...open('proposal'), todoId: undefined };
    expect(reason(requireHumanCard(draft('Ship it?'), [proposal], null, undefined))).toBeNull();
  });

  test('long text belongs in the document', () => {
    expect(reason(requireHumanCard(draft(`${'a'.repeat(400)}?`), [], null, undefined))).toMatch(
      /^card_too_long/
    );
    expect(reason(requireHumanCard(draft(`${'a'.repeat(399)}?`), [], null, undefined))).toBeNull();
  });

  test('internal ids stay off the card, except a home proposal that must show its hash', () => {
    for (const id of [
      '44fe354',
      '44fe3547',
      '44fe3547-0fec-4428-920c-a4614ddac82b',
      '594914c7d5e05615ff1d7d9d327d07875d613b46',
    ])
      expect(reason(requireHumanCard(draft(`Card ${id} ok?`), [], null, undefined))).toMatch(
        /^card_internal_id/
      );
    expect(
      reason(requireHumanCard(draft('Merge #9930 for 12345678?'), [], null, undefined))
    ).toBeNull();
    expect(reason(requireHumanCard(draft('Was it defaced?'), [], null, undefined))).toBeNull();
    const confirm = { path: 'a', sha256: 'b' } as never;
    expect(
      reason(requireHumanCard({ ...draft('Save 44fe3547?'), confirm }, [], null, undefined))
    ).toBeNull();
  });

  test('a set language is enforced; an unset or system language is not', () => {
    expect(reason(requireHumanCard(draft('Ship it?'), [], null, 'zh-Hans'))).toMatch(
      /^card_language/
    );
    expect(reason(requireHumanCard(draft('现在发布吗?'), [], null, 'zh-Hans'))).toBeNull();
    expect(reason(requireHumanCard(draft('现在发布吗?'), [], null, 'en'))).toMatch(
      /^card_language/
    );
    expect(reason(requireHumanCard(draft('Ship #9930 现在?'), [], null, 'en'))).toBeNull();
    for (const language of ['system', undefined] as const)
      expect(reason(requireHumanCard(draft('现在发布吗?'), [], null, language))).toBeNull();
  });
});

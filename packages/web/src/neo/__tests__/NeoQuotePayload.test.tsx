import { describe, expect, it } from 'vitest';
import { neoDraftPayload, neoQuoteExcerpt } from '../neo-intake.ts';
import { neoMessageReplyLabels } from '../NeoPublicConversation.tsx';

describe('neoDraftPayload quote', () => {
  it('sends the quoted message as replyTo and leaves the reply text alone', () => {
    const payload = neoDraftPayload({
      sessionId: 'neo:root',
      requestId: 'new-ask',
      text: 'Why?',
      quote: {
        author: 'Neo',
        text: 'First',
        anchor: 'source',
        replyTo: { kind: 'message', id: 'publication-1' },
      },
    });
    expect(payload).toMatchObject({
      content: 'Why?',
      replyTo: { kind: 'message', id: 'publication-1' },
    });
  });
});

describe('neoQuoteExcerpt', () => {
  it('trims, keeps 500 characters and normalizes line endings', () => {
    expect(neoQuoteExcerpt(` ${'a'.repeat(500)} `)).toBe('a'.repeat(500));
    expect(neoQuoteExcerpt('a'.repeat(501))).toBe(`${'a'.repeat(500)}…`);
    expect(neoQuoteExcerpt('a\rb\r\nc\u2028d\u2029e')).toBe('a\nb\nc\nd\ne');
  });

  it('counts Unicode characters without splitting surrogate pairs', () => {
    const excerpt = neoQuoteExcerpt('😀'.repeat(501));
    expect(Array.from(excerpt)).toHaveLength(501);
    expect(excerpt.replaceAll('😀', '')).toBe('…');
  });
});

describe('neoMessageReplyLabels', () => {
  it('labels each message by its request or publication id with an excerpt', () => {
    const labels = neoMessageReplyLabels([
      { kind: 'ask', key: 'a', ask: { requestId: 'r1', content: 'Ship it' } },
      {
        kind: 'publication',
        key: 'p',
        publication: { publicationId: 'p1', shortText: 'Shipped.' },
        replyTo: null,
      },
    ] as never);
    expect([...labels]).toEqual([
      ['message:r1', { label: 'Ship it', askId: '' }],
      ['message:p1', { label: 'Shipped.', askId: '' }],
    ]);
  });
});

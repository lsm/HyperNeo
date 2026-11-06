import { neoReplyExcerpt } from '@hyperneo/shared/types/neo-ask';
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
  it.each([
    'a'.repeat(300),
    'a'.repeat(301),
    'a'.repeat(500),
    '😀'.repeat(501),
    ' a\rb\r\nc\u2028d\u2029e ',
  ])('matches the stored reply excerpt for %j', (text) => {
    expect(neoQuoteExcerpt(text)).toBe(neoReplyExcerpt(text));
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

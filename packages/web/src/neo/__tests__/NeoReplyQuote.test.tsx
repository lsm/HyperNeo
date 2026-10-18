import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../lib/i18n/index.ts';
import { NeoPublicConversation } from '../NeoPublicConversation.tsx';
import { projectNeoPublicConversation } from '../public-conversation.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const origin = (messageId: string) => ({ sessionId: root, messageId });
const ask = (
  requestId: string,
  sequence: number,
  text: string,
  replyTo?: NeoConversationAsk['replyTo'] & { author?: 'neo' | 'user'; excerpt?: string }
): NeoConversationAsk => ({
  conversationId,
  requestId,
  askOrigin: origin(requestId),
  content: text,
  sequence,
  createdAt: '2026-10-18T12:00:00Z',
  ...(replyTo ? { replyTo } : {}),
});
const publication = (publicationId: string, sequence: number, text: string): NeoPublication => ({
  conversationId,
  publicationId,
  askOrigin: origin('first'),
  producerInput: { sessionId: 'neo:holder:fictional', messageId: 'consult' },
  shortText: text,
  fullText: text,
  links: [],
  sequence,
  createdAt: '2026-10-18T11:00:00Z',
});
const conversation = (
  asks: NeoConversationAsk[],
  publications: NeoPublication[],
  hasEarlier = false
) =>
  projectNeoPublicConversation(
    root,
    { conversationId, status: 'ready', items: asks, nextAfter: 9, hasMore: false, hasEarlier },
    {
      conversationId,
      status: 'ready',
      items: publications,
      nextAfter: 9,
      hasMore: false,
      hasEarlier,
    }
  );
const quoteBar = (container: Element, replyTo: string) =>
  container.querySelector(`[data-reply-to="${replyTo}"] [data-quote-bar]`) as HTMLElement;

const scrolled: Element[] = [];
beforeEach(() => {
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});
afterEach(() => {
  cleanup();
  scrolled.length = 0;
  vi.useRealTimers();
});

describe('reply quote block', () => {
  it('opens a reply bubble with the quoted author, accent and two-line excerpt', () => {
    const { container } = render(
      <NeoPublicConversation
        conversation={conversation(
          [
            ask('mine', 1, 'My earlier thought'),
            ask('reply', 3, 'Following up', {
              kind: 'message',
              id: 'answer',
              author: 'neo',
              excerpt: 'Neo said this',
            }),
            ask('self', 4, 'And me', {
              kind: 'message',
              id: 'mine',
              author: 'user',
              excerpt: 'My earlier thought',
            }),
          ],
          [publication('answer', 2, 'Neo said this')]
        )}
      />
    );
    const toNeo = quoteBar(container, 'message:answer');
    expect(toNeo.closest('.neo-message-bubble')).toBeTruthy();
    expect(toNeo.textContent).toBe('NeoNeo said this');
    expect(toNeo.querySelector('.line-clamp-2')?.textContent).toBe('Neo said this');
    expect(toNeo.querySelector('[aria-hidden="true"]')?.className).toContain('bg-accent');
    const toSelf = quoteBar(container, 'message:mine');
    expect(toSelf.textContent).toBe(`${t('chat.you')}My earlier thought`);
    expect(toSelf.querySelector('[aria-hidden="true"]')?.className).toContain('neo-user-accent');
  });

  it('scrolls to a loaded original and highlights it for about 1.5 s', () => {
    vi.useFakeTimers();
    const { container } = render(
      <NeoPublicConversation
        conversation={conversation(
          [ask('reply', 2, 'Following up', { kind: 'message', id: 'answer', excerpt: 'Hi' })],
          [publication('answer', 1, 'Hi')]
        )}
      />
    );
    fireEvent.click(quoteBar(container, 'message:answer'));
    const original = container.querySelector('[data-message-ref="answer"]')!;
    expect(scrolled).toEqual([original]);
    expect(original.classList.contains('neo-message-flash')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(original.classList.contains('neo-message-flash')).toBe(false);
  });

  it('loads earlier history until the original appears, then scrolls to it', async () => {
    const reply = ask('reply', 3, 'Following up', {
      kind: 'message',
      id: 'old',
      author: 'neo',
      excerpt: 'An old answer',
    });
    const pages = [
      conversation([reply], [], true),
      conversation([ask('middle', 2, 'Middle'), reply], [], true),
      conversation([ask('middle', 2, 'Middle'), reply], [publication('old', 1, 'An old answer')]),
    ];
    const loads = vi.fn();
    function Harness() {
      const [page, setPage] = useState(0);
      return (
        <NeoPublicConversation
          conversation={pages[page]}
          onLoadEarlier={() => {
            loads();
            setPage((current) => Math.min(current + 1, pages.length - 1));
          }}
        />
      );
    }
    const { container } = render(<Harness />);
    expect(container.querySelector('[data-message-ref="old"]')).toBeNull();
    await act(async () => {
      fireEvent.click(quoteBar(container, 'message:old'));
    });
    const original = container.querySelector('[data-message-ref="old"]');
    expect(loads).toHaveBeenCalledTimes(2);
    expect(scrolled).toEqual([original]);
    expect(original?.classList.contains('neo-message-flash')).toBe(true);
  });

  it('says the original is unavailable and does nothing on tap when it is gone', () => {
    const loads = vi.fn();
    const { container } = render(
      <NeoPublicConversation
        conversation={conversation(
          [ask('reply', 2, 'Following up', { kind: 'message', id: 'gone', author: 'neo' })],
          [],
          true
        )}
        onLoadEarlier={loads}
      />
    );
    const bar = quoteBar(container, 'message:gone');
    expect(bar.tagName).toBe('DIV');
    expect(bar.textContent).toContain(t('chat.originalUnavailable'));
    fireEvent.click(bar);
    expect(loads).not.toHaveBeenCalled();
    expect(scrolled).toEqual([]);
  });

  it('keeps showing the question text for a reply to a question and opens its card', () => {
    const card = document.createElement('div');
    card.setAttribute('data-ask', 'ask-1');
    document.body.appendChild(card);
    const { container } = render(
      <NeoPublicConversation
        conversation={conversation(
          [ask('reply', 1, 'CLI picker', { kind: 'question', id: 'q1' })],
          []
        )}
        replyLabels={new Map([['question:q1', { label: 'Which picker?', askId: 'ask-1' }]])}
      />
    );
    const bar = quoteBar(container, 'question:q1');
    expect(bar.textContent).toBe('NeoWhich picker?');
    fireEvent.click(bar);
    expect(scrolled).toEqual([card]);
    card.remove();
  });
});

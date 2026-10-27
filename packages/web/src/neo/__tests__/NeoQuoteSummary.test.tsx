import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '../../lib/session-store.ts';
import { NeoComposer } from '../NeoComposer.tsx';
import { NeoPublicConversation } from '../NeoPublicConversation.tsx';
import type { NeoDraft, NeoQuote } from '../neo-intake.ts';
import { projectNeoPublicConversation } from '../public-conversation.ts';

vi.mock('../NeoPreferences.tsx', () => ({ NeoPreferences: () => null }));
vi.mock('../NeoVoice.tsx', () => ({ NeoVoice: () => null }));
vi.mock('../../lib/state.ts', () => ({ connectionState: { value: 'connected' } }));

const conversationId = '10000000-0000-4000-8000-000000000001';
const sessionId = `neo:${conversationId}`;
const publication: NeoPublication = {
  conversationId,
  publicationId: '20000000-0000-4000-8000-000000000001',
  askOrigin: { sessionId, messageId: 'original' },
  producerInput: { sessionId, messageId: 'original' },
  shortText: 'The app is ready for review.',
  fullText: '**The app:** Detailed implementation notes that belong in the expanded message.',
  links: [],
  sequence: 1,
  createdAt: '2026-10-19T12:00:00Z',
};

function Chat({
  summary = publication.shortText,
  storedExcerpt,
}: {
  summary?: string;
  storedExcerpt?: string;
}) {
  const [quote, setQuote] = useState<NeoQuote>();
  const [asks, setAsks] = useState<NeoConversationAsk[]>([]);
  const [draft, setDraft] = useState('Looks good.');
  const store = {
    agentState: signal({ status: 'idle' }),
    isWorking: signal(false),
    error: signal(null),
  } as unknown as SessionStore;
  const conversation = projectNeoPublicConversation(
    sessionId,
    {
      conversationId,
      status: 'ready',
      items: asks,
      hasMore: false,
      hasEarlier: false,
      nextAfter: asks.length,
    },
    {
      conversationId,
      status: 'ready',
      items: [{ ...publication, shortText: summary }],
      hasMore: false,
      hasEarlier: false,
      nextAfter: 1,
    }
  );
  async function send(submission: NeoDraft) {
    setAsks([
      {
        conversationId,
        requestId: 'reply',
        askOrigin: { sessionId, messageId: 'reply' },
        content: submission.text,
        replyTo: submission.quote?.replyTo
          ? {
              ...submission.quote.replyTo,
              ...(storedExcerpt ? { author: 'neo' as const, excerpt: storedExcerpt } : {}),
            }
          : undefined,
        sequence: 1,
        createdAt: '2026-10-19T12:01:00Z',
      },
    ]);
    setQuote(undefined);
    return { ok: true, requestId: 'reply', messageId: 'reply', created: true } as const;
  }
  return (
    <>
      <NeoPublicConversation conversation={conversation} onQuote={setQuote} />
      <NeoComposer
        store={store}
        sessionId={sessionId}
        draft={draft}
        onDraft={setDraft}
        onError={() => {}}
        onTranscript={() => {}}
        onSend={send}
        quote={quote}
      />
    </>
  );
}

afterEach(cleanup);

describe('Neo publication quote preview', () => {
  it.each([300, 301, 500])(
    'matches the saved excerpt for a %s-character summary',
    async (length) => {
      const expected = length === 300 ? 'a'.repeat(300) : `${'a'.repeat(300)}…`;
      const { container } = render(<Chat summary={'a'.repeat(length)} storedExcerpt={expected} />);
      fireEvent.click(screen.getByRole('button', { name: 'Reply to Neo’s message' }));
      const preview = screen.getByRole('region', { name: /^Replying to Neo/ });
      expect(preview.querySelector('.line-clamp-2')?.textContent).toBe(expected);
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(container.querySelector('.neo-message-user')).toBeTruthy());
      const sent = container.querySelector<HTMLElement>('.neo-message-user')!;
      expect(within(sent).getByText(expected)).toBeTruthy();
    }
  );

  it.each(['button', 'menu'])(
    'uses the same summary before and after sending via %s',
    async (via) => {
      const { container } = render(<Chat />);
      if (via === 'menu') {
        fireEvent.touchStart(container.querySelector('article')!, {
          touches: [{ clientX: 10, clientY: 10 }],
        });
        await screen.findByRole('menuitem', { name: 'Reply' });
        fireEvent.click(screen.getByRole('menuitem', { name: 'Reply' }));
      } else {
        fireEvent.click(screen.getByRole('button', { name: 'Reply to Neo’s message' }));
      }
      const preview = screen.getByRole('region', { name: /^Replying to Neo/ });
      expect(within(preview).getByText(publication.shortText ?? '')).toBeTruthy();
      expect(preview.textContent).not.toContain('**The app:**');
      expect(document.activeElement?.tagName).toBe('TEXTAREA');
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(container.querySelector('.neo-message-user')).toBeTruthy());
      const sent = container.querySelector<HTMLElement>('.neo-message-user')!;
      expect(within(sent).getByText(publication.shortText ?? '')).toBeTruthy();
      expect(sent.textContent).not.toContain('Detailed implementation notes');
      expect(screen.queryByRole('region', { name: /^Replying to Neo/ })).toBeNull();
    }
  );
});

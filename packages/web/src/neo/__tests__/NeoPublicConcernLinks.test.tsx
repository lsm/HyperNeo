import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import type { SessionStore } from '../../lib/session-store.ts';
import { NeoConversation, publicConcernSession } from '../NeoConversation.tsx';
import { projectNeoPublicConversation } from '../public-conversation.ts';

afterEach(cleanup);
const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const holder = 'neo:fictional-holder';
const authors = new Map([[holder, 'Fictional garden']]);
const snapshot: NeoSnapshot = {
  ok: true,
  sessionId: root,
  concerns: [
    {
      id: 'garden',
      title: 'Fictional garden',
      summary: 'Fictional',
      context: '',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  publicAuthorBindings: [{ kind: 'concern', concernId: 'garden', sessionId: holder }],
  work: [],
  consultations: [],
};
const publication: NeoPublication = {
  conversationId,
  publicationId: '20000000-0000-4000-8000-000000000001',
  askOrigin: { sessionId: root, messageId: 'original' },
  producerInput: { sessionId: holder, messageId: 'holder-input' },
  shortText: 'Fictional answer',
  fullText: 'Fictional detail',
  links: [
    { kind: 'concern', id: 'garden', label: 'Garden context' },
    { kind: 'concern', id: 'missing', label: 'Unavailable context' },
    { kind: 'work', id: 'garden', label: 'Work detail' },
    { kind: 'consultation', id: 'garden', label: 'Consultation detail' },
  ],
  sequence: 1,
  createdAt: '2026-10-01T20:00:00Z',
};
const conversation = projectNeoPublicConversation(
  root,
  { conversationId, status: 'ready', items: [], nextAfter: 0, hasMore: false, hasEarlier: false },
  {
    conversationId,
    status: 'ready',
    items: [publication],
    nextAfter: 1,
    hasMore: false,
    hasEarlier: false,
  }
);
function mount(value: NeoSnapshot | null = snapshot, available = authors, enabled = true) {
  const open = vi.fn();
  const store = {
    sdkMessages: signal([]),
    agentState: signal({ status: 'idle' }),
    activeSessionId: signal(root),
    hasMoreMessages: signal(false),
    error: signal(null),
  } as unknown as SessionStore;
  const view = render(
    <NeoConversation
      store={store}
      sessionId={root}
      snapshot={value}
      publicConversation={conversation}
      publicAuthors={available}
      onOpenPublicAuthor={enabled ? open : undefined}
    />
  );
  return { ...view, open, store };
}

describe('public concern reference navigation', () => {
  it('opens the verified holder through the existing Neo callback, not an execution action', () => {
    const { open } = mount();
    const refs = screen.getByRole('list', { name: 'Related Neo scenes' });
    fireEvent.click(within(refs).getByRole('button', { name: 'Garden context' }));
    expect(open).toHaveBeenCalledExactlyOnceWith(holder);
    expect(within(refs).getAllByRole('button')).toHaveLength(1);
    for (const label of ['Unavailable context', 'Work detail', 'Consultation detail']) {
      expect(within(refs).getByText(label)).toBeTruthy();
      expect(within(refs).queryByRole('button', { name: label })).toBeNull();
    }
    expect(refs.querySelector('a')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start work' })).toBeNull();
  });

  it.each(['no-snapshot', 'no-concern', 'no-binding', 'no-author', 'no-opener'])(
    'keeps the authored reference as text with %s',
    (missing) => {
      mount(
        missing === 'no-snapshot'
          ? null
          : {
              ...snapshot,
              concerns: missing === 'no-concern' ? [] : snapshot.concerns,
              publicAuthorBindings: missing === 'no-binding' ? [] : snapshot.publicAuthorBindings,
            },
        missing === 'no-author' ? new Map() : authors,
        missing !== 'no-opener'
      );
      const refs = screen.getByRole('list', { name: 'Related Neo scenes' });
      expect(within(refs).getByText('Garden context')).toBeTruthy();
      expect(within(refs).queryAllByRole('button')).toEqual([]);
    }
  );

  it('re-evaluates current bindings after a snapshot changes while retaining the public entry', () => {
    const { container, open, store, rerender } = mount();
    const article = container.querySelector('[data-public-entry]');
    rerender(
      <NeoConversation
        store={store}
        sessionId={root}
        snapshot={{ ...snapshot, publicAuthorBindings: [] }}
        publicConversation={conversation}
        publicAuthors={authors}
        onOpenPublicAuthor={open}
      />
    );
    expect(container.querySelector('[data-public-entry]')).toBe(article);
    expect(screen.queryByRole('button', { name: 'Garden context' })).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ['concern', 'garden', holder],
    ['concern', 'missing', null],
    ['work', 'garden', null],
    ['consultation', 'garden', null],
  ] as const)('resolves only the actual concern kind %s and id %s', (kind, id, expected) => {
    expect(publicConcernSession({ kind, id }, snapshot, authors)).toBe(expected);
  });
});

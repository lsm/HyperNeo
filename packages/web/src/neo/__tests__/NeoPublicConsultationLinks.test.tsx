import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import type { SessionStore } from '../../lib/session-store.ts';
import { connectionState } from '../../lib/state.ts';
import { NeoConversation } from '../NeoConversation.tsx';
import { projectNeoPublicConversation } from '../public-conversation.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const work: NeoWork = {
  id: 'garden',
  requestKey: 'garden',
  concernId: null,
  originSessionId: root,
  originMessageId: 'ask',
  title: 'Fictional flower review',
  instruction: 'A fictional work brief',
  sessionId: null,
  status: 'proposed',
  report: null,
  createdAt: 1,
  updatedAt: 1,
};
const snapshot: NeoSnapshot = {
  ok: true,
  sessionId: root,
  concerns: [
    {
      id: 'garden',
      title: 'Garden',
      summary: 'S',
      context: 'C',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  publicAuthorBindings: [{ kind: 'concern', concernId: 'garden', sessionId: 'holder' }],
  work: [work],
  consultations: [],
};
const publication: NeoPublication = {
  conversationId,
  publicationId: '20000000-0000-4000-8000-000000000001',
  askOrigin: { sessionId: root, messageId: 'ask' },
  producerInput: { sessionId: root, messageId: 'ask' },
  shortText: 'The fictional context holder authored this response.',
  fullText: 'Full fictional response',
  links: [
    { kind: 'consultation', id: 'garden', label: 'Garden context check' },
    { kind: 'work', id: 'garden', label: 'Flower work' },
    { kind: 'concern', id: 'garden', label: 'Garden context' },
    { kind: 'consultation', id: 'missing', label: 'Earlier context check' },
  ],
  sequence: 1,
  createdAt: '2026-10-02T00:00:00Z',
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
function store() {
  return {
    sdkMessages: signal([]),
    agentState: signal({ status: 'idle' }),
    activeSessionId: signal(root),
    hasMoreMessages: signal(false),
    error: signal(null),
    sessionInfo: signal({ metadata: {} }),
    messagesLoaded: signal(true),
    loadErrorKind: signal(null),
    isWorking: signal(false),
  } as unknown as SessionStore;
}
beforeEach(() => {
  connectionState.value = 'connected';
});
afterEach(cleanup);

describe('public consultation reference capability', () => {
  it('routes matching IDs only to their declared scene kind', () => {
    const openConsultation = vi.fn();
    const openWork = vi.fn();
    const openAuthor = vi.fn();
    render(
      <NeoConversation
        store={store()}
        sessionId={root}
        works={[work]}
        snapshot={snapshot}
        publicConversation={conversation}
        publicAuthors={new Map([['holder', 'Garden']])}
        publicConsultationIds={new Set(['garden'])}
        onOpenPublicConsultation={openConsultation}
        onOpenPublicWork={openWork}
        onOpenPublicAuthor={openAuthor}
      />
    );
    const refs = within(screen.getByRole('list', { name: 'Related Neo scenes' }));
    fireEvent.click(refs.getByRole('button', { name: 'Garden context check' }));
    expect(openConsultation).toHaveBeenCalledExactlyOnceWith('garden');
    expect(openWork).not.toHaveBeenCalled();
    expect(openAuthor).not.toHaveBeenCalled();
    fireEvent.click(refs.getByRole('button', { name: 'Flower work' }));
    expect(openWork).toHaveBeenCalledExactlyOnceWith('garden');
    expect(openConsultation).toHaveBeenCalledTimes(1);
    expect(openAuthor).not.toHaveBeenCalled();
    fireEvent.click(refs.getByRole('button', { name: 'Garden context' }));
    expect(openAuthor).toHaveBeenCalledExactlyOnceWith('holder');
    expect(openConsultation).toHaveBeenCalledTimes(1);
    expect(openWork).toHaveBeenCalledTimes(1);
    expect(refs.queryByRole('button', { name: 'Earlier context check' })).toBeNull();
    expect(refs.getByText('Earlier context check')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start work' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it.each(['no-opener', 'no-current-ids', 'other-scope'])(
    'keeps the authored label readable with %s',
    (missing) => {
      const open = vi.fn();
      render(
        <NeoConversation
          store={store()}
          sessionId={root}
          snapshot={snapshot}
          publicConversation={conversation}
          publicConsultationIds={
            missing === 'no-current-ids'
              ? undefined
              : new Set([missing === 'other-scope' ? 'another-check' : 'garden'])
          }
          onOpenPublicConsultation={missing === 'no-opener' ? undefined : open}
        />
      );
      expect(screen.getByText('Garden context check')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Garden context check' })).toBeNull();
      expect(open).not.toHaveBeenCalled();
    }
  );

  it('rechecks current capability without replacing or collapsing the durable public entry', async () => {
    const native = store();
    const open = vi.fn();
    const view = render(
      <NeoConversation
        store={native}
        sessionId={root}
        publicConversation={conversation}
        publicConsultationIds={new Set(['garden'])}
        onOpenPublicConsultation={open}
      />
    );
    const entry = view.container.querySelector('[data-public-entry]');
    expect(await screen.findByText('Full fictional response')).toBeTruthy();
    const rerender = (ids: ReadonlySet<string>, opener: typeof open | undefined) =>
      view.rerender(
        <NeoConversation
          store={native}
          sessionId={root}
          publicConversation={conversation}
          publicConsultationIds={ids}
          onOpenPublicConsultation={opener}
        />
      );
    rerender(new Set(), open);
    expect(view.container.querySelector('[data-public-entry]')).toBe(entry);
    expect(screen.getByText('Full fictional response')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Garden context check' })).toBeNull();
    expect(screen.getByText('Garden context check')).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    rerender(new Set(['garden']), open);
    fireEvent.click(screen.getByRole('button', { name: 'Garden context check' }));
    expect(open).toHaveBeenCalledExactlyOnceWith('garden');
    rerender(new Set(['garden']), undefined);
    expect(screen.queryByRole('button', { name: 'Garden context check' })).toBeNull();
    expect(view.container.querySelector('[data-public-entry]')).toBe(entry);
    expect(screen.getByText('Full fictional response')).toBeTruthy();
  });
});

import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { signal } from '@preact/signals';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '../../lib/session-store.ts';
import { connectionState } from '../../lib/state.ts';
import { NeoConversation } from '../NeoConversation.tsx';
import { NeoLive } from '../NeoLive.tsx';
import { projectNeoPublicConversation } from '../public-conversation.ts';

const useNeoMock = vi.hoisted(() => vi.fn());
vi.mock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
vi.mock('../../islands/ToastContainer.tsx', () => ({ default: () => null }));
vi.mock('../NeoComposer.tsx', () => ({
  NeoComposer: (props: { draft: string; onDraft: (value: string) => void }) => (
    <textarea
      aria-label="Draft"
      value={props.draft}
      onInput={(event) => props.onDraft(event.currentTarget.value)}
    />
  ),
}));

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const work = (status: NeoWork['status'] = 'proposed'): NeoWork => ({
  id: 'garden',
  requestKey: 'garden',
  concernId: null,
  originSessionId: root,
  originMessageId: 'ask',
  title: 'Fictional flower review',
  instruction: 'The complete fictional brief',
  sessionId: null,
  status,
  report: status === 'reported' ? 'Fictional response, not verified completion' : null,
  createdAt: 1,
  updatedAt: 1,
});
const snapshot = (items: NeoWork[]): NeoSnapshot => ({
  ok: true,
  sessionId: root,
  concerns: [
    {
      id: 'garden',
      title: 'Fictional garden',
      summary: 'S',
      context: 'C',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  publicAuthorBindings: [{ kind: 'concern', concernId: 'garden', sessionId: 'holder' }],
  work: items,
  consultations: [],
});
const publication: NeoPublication = {
  conversationId,
  publicationId: '20000000-0000-4000-8000-000000000001',
  askOrigin: { sessionId: root, messageId: 'ask' },
  producerInput: { sessionId: root, messageId: 'ask' },
  shortText: 'Fictional saved response',
  fullText: 'Full fictional response',
  links: [
    { kind: 'work', id: 'garden', label: 'Flower work' },
    { kind: 'concern', id: 'garden', label: 'Garden context' },
    { kind: 'consultation', id: 'garden', label: 'Context return' },
    { kind: 'work', id: 'missing', label: 'Unavailable work' },
  ],
  sequence: 1,
  createdAt: '2026-10-01T20:00:00Z',
};
const conversation = projectNeoPublicConversation(
  root,
  {
    conversationId,
    status: 'ready',
    items: [],
    nextAfter: 0,
    hasMore: false,
    hasEarlier: false,
  },
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
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('public work reference navigation', () => {
  it.each(['proposed', 'queued', 'reported', 'failed', 'cancelled'] as const)(
    'opens a current %s work id without confusing matching concern or consultation ids',
    (status) => {
      const openWork = vi.fn();
      const openAuthor = vi.fn();
      render(
        <NeoConversation
          store={store()}
          sessionId={root}
          works={[work(status)]}
          snapshot={snapshot([work(status)])}
          publicConversation={conversation}
          publicAuthors={new Map([['holder', 'Fictional garden']])}
          onOpenPublicWork={openWork}
          onOpenPublicAuthor={openAuthor}
        />
      );
      const refs = screen.getByRole('list', { name: 'Related Neo scenes' });
      fireEvent.click(within(refs).getByRole('button', { name: 'Flower work' }));
      expect(openWork).toHaveBeenCalledExactlyOnceWith('garden');
      expect(openAuthor).not.toHaveBeenCalled();
      fireEvent.click(within(refs).getByRole('button', { name: 'Garden context' }));
      expect(openAuthor).toHaveBeenCalledExactlyOnceWith('holder');
      expect(openWork).toHaveBeenCalledTimes(1);
      expect(within(refs).queryByRole('button', { name: 'Context return' })).toBeNull();
      expect(within(refs).queryByRole('button', { name: 'Unavailable work' })).toBeNull();
      expect(within(refs).getByText('Context return')).toBeTruthy();
      expect(within(refs).getByText('Unavailable work')).toBeTruthy();
      expect(refs.querySelector('a')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Start work' })).toBeNull();
    }
  );

  it.each(['no-opener', 'no-current-work'])(
    'retains the authored work label as text with %s',
    (missing) => {
      render(
        <NeoConversation
          store={store()}
          sessionId={root}
          works={missing === 'no-current-work' ? [] : [work()]}
          publicConversation={conversation}
          onOpenPublicWork={missing === 'no-opener' ? undefined : vi.fn()}
        />
      );
      expect(screen.getByText('Flower work')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Flower work' })).toBeNull();
    }
  );

  it('rechecks the current work set without replacing the durable public entry', () => {
    const native = store();
    const open = vi.fn();
    const view = render(
      <NeoConversation
        store={native}
        sessionId={root}
        works={[work()]}
        publicConversation={conversation}
        onOpenPublicWork={open}
      />
    );
    const entry = view.container.querySelector('[data-public-entry]');
    view.rerender(
      <NeoConversation
        store={native}
        sessionId={root}
        works={[]}
        publicConversation={conversation}
        onOpenPublicWork={open}
      />
    );
    expect(view.container.querySelector('[data-public-entry]')).toBe(entry);
    expect(screen.queryByRole('button', { name: 'Flower work' })).toBeNull();
    expect(screen.getByText('Flower work')).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
  });

  it.each(['queued', 'reported'] as const)(
    'opens the actual %s work chat without an execution action or draft loss',
    (status) => {
      const current = snapshot([{ ...work(status), sessionId: 'flower-session' }]);
      const model = signal({
        sessionId: root,
        selectedId: null as string | null,
        snapshot: current,
        viewSnapshot: current,
        viewPublicConversation: conversation,
        publicAuthors: new Map([['holder', 'Fictional garden']]),
        store: store(),
        error: null,
        setError: vi.fn(),
        open: vi.fn(),
        act: vi.fn(),
        busyWork: null,
        asks: { retry: vi.fn() },
        publications: { refresh: vi.fn() },
      });
      useNeoMock.mockImplementation(() => model.value);
      const opened = vi.spyOn(window, 'open').mockReturnValue(null);
      const view = render(<NeoLive />);
      const entry = view.container.querySelector('[data-public-entry]');
      fireEvent.input(screen.getByRole('textbox', { name: 'Draft' }), {
        target: { value: 'Keep this fictional draft' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Flower work' }));
      expect(opened).toHaveBeenCalledExactlyOnceWith(
        '/session/flower-session',
        '_blank',
        'noopener'
      );
      expect(screen.queryByRole('region', { name: 'Selected work' })).toBeNull();
      expect(model.value.act).not.toHaveBeenCalled();
      expect(model.value.open).not.toHaveBeenCalled();
      expect(view.container.querySelector('[data-public-entry]')).toBe(entry);
      expect((screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement).value).toBe(
        'Keep this fictional draft'
      );
      act(() => {
        model.value = { ...model.value, selectedId: 'garden' };
      });
      expect(screen.queryByRole('button', { name: 'Flower work' })).toBeNull();
      expect(screen.getByText('Flower work')).toBeTruthy();
      opened.mockRestore();
    }
  );
});

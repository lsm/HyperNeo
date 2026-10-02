import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { signal, type Signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, SessionState } from '@hyperneo/shared';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { SessionStore } from '../../lib/session-store.ts';
import { connectionState } from '../../lib/state.ts';
import { NeoLive } from '../NeoLive.tsx';
import { projectNeoPublicConversation } from '../public-conversation.ts';
import { projectNeoPublicHolderConversation } from '../public-holder-conversation.ts';
import { projectNeoPublicAuthors } from '../public-authors.ts';
import type { NeoAskState } from '../useNeoConversationAsks.ts';
import type { NeoPublicationState } from '../useNeoPublications.ts';

const useNeoMock = vi.hoisted(() => vi.fn());
const transport = vi.hoisted(() => ({ hub: null as unknown }));
vi.mock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => transport.hub,
    getHubIfConnected: () => transport.hub,
  },
}));
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
const holder = 'holder-a';
const otherHolder = 'holder-b';
const initialConnection = connectionState.value;
const ask = (id: string, sessionId = root, sequence = 1): NeoConversationAsk => ({
  conversationId,
  requestId: id,
  askOrigin: { sessionId, messageId: id },
  content: `Public request **${id}**`,
  sequence,
  createdAt: `2026-10-01T01:00:0${sequence}Z`,
});
const publication = (
  id: string,
  producer = holder,
  origin = { sessionId: root, messageId: 'root-ask' },
  sequence = 1
): NeoPublication => ({
  conversationId,
  publicationId: id,
  askOrigin: origin,
  producerInput: { sessionId: producer, messageId: `internal-${id}` },
  shortText: `Saved reply **${id}**`,
  fullText: `## Full ${id}\n\n| Evidence | Result |\n| --- | --- |\n| Fictional | Reported |`,
  links: [{ kind: 'concern', id: 'a', label: 'Source context' }],
  sequence,
  createdAt: `2026-10-01T01:00:1${sequence}Z`,
});
const snapshot = (): NeoSnapshot => ({
  ok: true,
  sessionId: root,
  concerns: ['a', 'b'].map((id) => ({
    id,
    title: id === 'a' ? 'Fictional research' : 'Other context',
    summary: 'Summary',
    context: 'Saved context',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  })),
  publicAuthorBindings: [
    { kind: 'concern', concernId: 'a', sessionId: holder },
    { kind: 'concern', concernId: 'b', sessionId: otherHolder },
  ],
  work: [],
  consultations: [],
  askOrigins: [],
});
const nativeState = (sessionId: string): SessionState =>
  ({
    sessionInfo: { id: sessionId, metadata: {} },
    agentState: { status: 'idle' },
    revision: 1,
    daemonEpoch: 'activation-test',
  }) as SessionState;
type Handler = (value: unknown, context: { channel: string }) => void;
let store: SessionStore;
let source: Signal<NeoSnapshot>;
let asks: Signal<NeoAskState>;
let publications: Signal<NeoPublicationState>;
let sessionId: Signal<string | null>;
let selectedId: Signal<string | null>;
let error: Signal<string | null>;
let events: Map<string, Set<Handler>>;
let connections: Set<(state: string) => void>;
let request: ReturnType<typeof vi.fn>;
let open: ReturnType<typeof vi.fn>;
let retryAsks: ReturnType<typeof vi.fn>;
let refreshPublications: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  connectionState.value = 'connected';
  events = new Map();
  connections = new Set();
  request = vi.fn(async (method: string, data: Record<string, unknown> = {}) => {
    if (method === 'state.session') return nativeState(String(data.sessionId));
    if (method === 'liveQuery.subscribe') return { subscriptionId: data.subscriptionId };
    if (method === 'session.get') return { session: { metadata: {} } };
    if (method === 'operation.invoke') return { capturedAt: 1, capabilities: [], resources: [] };
    return { success: true };
  });
  transport.hub = {
    request,
    joinChannel: vi.fn(),
    leaveChannel: vi.fn(),
    onEvent: (method: string, handler: Handler) => {
      const listeners = events.get(method) ?? new Set<Handler>();
      listeners.add(handler);
      events.set(method, listeners);
      return () => listeners.delete(handler);
    },
    onConnection: (handler: (state: string) => void) => {
      connections.add(handler);
      return () => connections.delete(handler);
    },
  };
  store = new SessionStore();
  await store.select(root);
  store.messagesLoaded.value = true;
  store.sdkMessages.value = [
    {
      type: 'assistant',
      uuid: 'private-execution',
      message: { content: [{ type: 'text', text: 'PRIVATE SDK EXECUTION' }] },
    },
    { type: 'result', uuid: 'private-result' },
  ] as unknown as ChatMessage[];
  source = signal(snapshot());
  asks = signal<NeoAskState>({
    conversationId,
    status: 'ready',
    items: [ask('root-ask'), ask('holder-ask', holder, 2), ask('other-ask', otherHolder, 3)],
    nextAfter: 3,
    hasEarlier: false,
    hasMore: false,
  });
  publications = signal<NeoPublicationState>({
    conversationId,
    status: 'ready',
    items: [
      publication('a-reply'),
      publication('b-reply', otherHolder, { sessionId: otherHolder, messageId: 'other-ask' }, 2),
    ],
    nextAfter: 2,
    hasEarlier: false,
    hasMore: false,
  });
  sessionId = signal<string | null>(root);
  selectedId = signal<string | null>(null);
  error = signal<string | null>(null);
  retryAsks = vi.fn();
  refreshPublications = vi.fn();
  open = vi.fn(async (id: string | null) => {
    const target = id === 'a' ? holder : id === 'b' ? otherHolder : root;
    await store.select(target);
    store.messagesLoaded.value = true;
    selectedId.value = id;
    sessionId.value = target;
  });
  useNeoMock.mockImplementation(() => {
    const rootSnapshot = source.value;
    const concernId = selectedId.value;
    const view = concernId
      ? {
          ...rootSnapshot,
          sessionId: sessionId.value,
          concerns: rootSnapshot.concerns.filter((item) => item.id === concernId),
          consultations: rootSnapshot.consultations?.filter((item) => item.concernId === concernId),
        }
      : rootSnapshot;
    const conversation = projectNeoPublicConversation(
      rootSnapshot.sessionId,
      asks.value,
      publications.value
    );
    return {
      store,
      sessionId: sessionId.value,
      selectedId: concernId,
      snapshot: rootSnapshot,
      viewSnapshot: view,
      viewPublicConversation: projectNeoPublicHolderConversation(
        conversation,
        rootSnapshot,
        sessionId.value
      ),
      publicAuthors: projectNeoPublicAuthors(rootSnapshot, publications.value),
      asks: { ...asks.value, retry: retryAsks },
      publications: { ...publications.value, refresh: refreshPublications },
      error: error.value,
      setError: (value: string) => (error.value = value),
      open,
      retry: vi.fn(),
      send: vi.fn(),
      act: vi.fn(),
      busyWork: null,
    };
  });
});

afterEach(async () => {
  cleanup();
  await store.destroy();
  expect(connections.size).toBe(0);
  expect([...events.values()].every((listeners) => listeners.size === 0)).toBe(true);
  connectionState.value = initialConnection;
  vi.clearAllMocks();
});

const publicView = () => screen.getByLabelText('Public conversation');
const askArticle = (id: string) =>
  [...publicView().querySelectorAll('article')].find((item) =>
    item.getAttribute('data-public-entry')?.includes(`"ask","${id}"`)
  )! as HTMLElement;
const toggle = (detail: HTMLDetailsElement) => {
  detail.open = true;
  fireEvent(detail, new Event('toggle'));
};

describe('NeoLive durable conversation activation', () => {
  it('never shows the SDK transcript for a root without a durable conversation identity', async () => {
    source.value = { ...source.value, sessionId: 'neo:legacy' };
    sessionId.value = 'neo:legacy';
    store.activeSessionId.value = 'neo:legacy';
    store.sessionState.value = nativeState('neo:legacy');
    render(<NeoLive />);
    expect(screen.queryByLabelText('Public conversation')).toBeNull();
    expect(screen.queryByText('PRIVATE SDK EXECUTION')).toBeNull();
    await act(async () => {
      source.value = snapshot();
      sessionId.value = root;
      store.activeSessionId.value = root;
      store.sessionState.value = nativeState(root);
    });
    expect(screen.getByLabelText('Public conversation')).toBeTruthy();
    expect(screen.queryByText('PRIVATE SDK EXECUTION')).toBeNull();
  });

  it('never flashes SDK history while a durable root waits for its first snapshot', async () => {
    source.value = { ...source.value, sessionId: null };
    render(<NeoLive />);
    expect(publicView()).toBeTruthy();
    expect(screen.getByText('Saved conversation is unavailable.')).toBeTruthy();
    expect(screen.queryByText('PRIVATE SDK EXECUTION')).toBeNull();
    expect(screen.queryByText(/No setup, no folders/)).toBeNull();
    await act(async () => {
      source.value = snapshot();
    });
    expect(await within(publicView()).findByText('a-reply', { selector: 'strong' })).toBeTruthy();
    expect(screen.queryByText('PRIVATE SDK EXECUTION')).toBeNull();
  });

  it('activates authored public rows and real lazy Markdown without visible SDK history', async () => {
    render(<NeoLive />);
    expect(await within(publicView()).findByText('a-reply', { selector: 'strong' })).toBeTruthy();
    expect(screen.queryByText('PRIVATE SDK EXECUTION')).toBeNull();
    expect(screen.queryByText(/Open full history/)).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    const reply = screen.getAllByText('Read full response', { selector: 'summary' })[0];
    toggle(reply.closest('details')!);
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Full a-reply' })).toBeTruthy();
    expect(within(publicView()).getAllByRole('img', { name: 'Message accepted' })).toHaveLength(3);
    expect(screen.getByLabelText('Draft')).toBeTruthy();
  });

  it('keeps saved rows visible during SDK loading and honest native-control failure', async () => {
    store.messagesLoaded.value = false;
    store.loadErrorKind.value = 'not-found';
    render(<NeoLive />);
    expect(await within(publicView()).findByText('a-reply', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText('Native session controls could not be loaded.')).toBeTruthy();
    expect(screen.queryByText('Opening your conversation…')).toBeNull();
    expect(screen.queryByLabelText('Draft')).toBeNull();
    await act(async () => {
      store.loadErrorKind.value = null;
      store.messagesLoaded.value = true;
    });
    expect(screen.getByLabelText('Draft')).toBeTruthy();
    await act(async () => {
      store.activeSessionId.value = 'stale-native-owner';
    });
    expect(screen.queryByLabelText('Public conversation')).toBeNull();
    expect(screen.queryByLabelText('Draft')).toBeNull();
  });

  it('opens verified holders in Neo, keeps original asks in scope, and restores per-view drafts', async () => {
    render(<NeoLive />);
    fireEvent.input(screen.getByLabelText('Draft'), { target: { value: 'Root unsent draft' } });
    fireEvent.click(within(publicView()).getByRole('button', { name: 'Fictional research' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('a'));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Fictional research' })).toBeTruthy()
    );
    expect(
      await within(askArticle('root-ask')).findByText('root-ask', { selector: 'strong' })
    ).toBeTruthy();
    expect(
      await within(askArticle('holder-ask')).findByText('holder-ask', { selector: 'strong' })
    ).toBeTruthy();
    expect(publicView().textContent).not.toContain('other-ask');
    expect(publicView().textContent).not.toContain('b-reply');
    expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('');
    fireEvent.input(screen.getByLabelText('Draft'), { target: { value: 'Holder unsent draft' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Back to Neo' })[0]);
    await waitFor(() =>
      expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe(
        'Root unsent draft'
      )
    );
    fireEvent.click(within(publicView()).getByRole('button', { name: 'Fictional research' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe(
        'Holder unsent draft'
      )
    );
  });

  it('does not turn unknown producers or conflicting bindings into execution navigation', async () => {
    publications.value = { ...publications.value, items: [publication('unknown', 'worker')] };
    source.value = {
      ...source.value,
      publicAuthorBindings: [
        ...source.value.publicAuthorBindings!,
        { kind: 'concern', concernId: 'b', sessionId: holder },
      ],
    };
    render(<NeoLive />);
    fireEvent.click(within(publicView()).getByRole('button', { name: 'Context holder' }));
    expect(await screen.findByText('This context holder is not available in Neo.')).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    await act(async () => {
      publications.value = { ...publications.value, items: [publication('conflict', holder)] };
    });
    fireEvent.click(within(publicView()).getByRole('button', { name: 'Context holder' }));
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelector('a[href^="/session/"]')).toBeNull();
    await act(async () => {
      publications.value = { ...publications.value, items: [publication('root-reply', root)] };
    });
    fireEvent.click(within(publicView()).getByRole('button', { name: 'Neo' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(null));
  });

  it('retains public rows on source failure and retries both owners without SDK fallback', async () => {
    asks.value = { ...asks.value, status: 'unavailable', hasEarlier: true };
    render(<NeoLive />);
    expect(await within(publicView()).findByText('a-reply', { selector: 'strong' })).toBeTruthy();
    expect(
      screen.getByText('Saved conversation is unavailable. Showing retained messages.')
    ).toBeTruthy();
    expect(screen.getByText('Showing part of your saved conversation.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry saved conversation' }));
    expect(retryAsks).toHaveBeenCalledTimes(1);
    expect(refreshPublications).toHaveBeenCalledTimes(1);
    await act(async () => {
      asks.value = { ...asks.value, status: 'ready', hasEarlier: false };
    });
    expect(screen.queryByRole('button', { name: 'Retry saved conversation' })).toBeNull();
    expect(screen.queryByText(/Showing part/)).toBeNull();
    expect(screen.queryByText('PRIVATE SDK EXECUTION')).toBeNull();
  });

  it('preserves the exact native question and selected answer across public reloads', async () => {
    const state = nativeState(root);
    store.sessionState.value = {
      ...state,
      agentState: {
        status: 'waiting_for_input',
        pendingQuestion: {
          toolUseId: 'native-choice',
          askedAt: 1,
          questions: [
            {
              question: 'Keep this draft?',
              header: 'Draft',
              multiSelect: false,
              options: [{ label: 'Keep draft', description: 'Do not execute' }],
            },
          ],
        },
      },
    };
    const refresh = vi.spyOn(store, 'refresh');
    render(<NeoLive />);
    const option = await screen.findByRole('button', { name: /Keep draft/ });
    fireEvent.click(option);
    const submit = screen.getByRole('button', { name: 'Submit Response' });
    await act(async () => {
      asks.value = { ...asks.value, status: 'loading' };
      publications.value = { ...publications.value, status: 'unavailable' };
    });
    expect(screen.getByRole('button', { name: /Keep draft/ })).toBe(option);
    expect(screen.getByRole('button', { name: 'Submit Response' })).toBe(submit);
    expect(submit.hasAttribute('disabled')).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        'question.respond',
        expect.objectContaining({
          sessionId: root,
          toolUseId: 'native-choice',
          responses: [{ questionIndex: 0, selectedLabels: ['Keep draft'], customText: undefined }],
        }),
        expect.anything()
      )
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('keeps per-request checks and real boards attributed by both original identifiers', async () => {
    source.value = {
      ...source.value,
      consultations: ['root-ask', 'holder-ask'].map((id) => ({
        id,
        requestKey: id,
        concernId: 'a',
        originSessionId: root,
        originMessageId: id,
        sessionId: holder,
        question: `Checking ${id}`,
        status: 'pending',
        answer: null,
        createdAt: 1,
      })),
      askOrigins: [
        {
          kind: 'consultation',
          id: 'root-ask',
          origin: { sessionId: root, messageId: 'root-ask' },
        },
        {
          kind: 'consultation',
          id: 'holder-ask',
          origin: { sessionId: holder, messageId: 'holder-ask' },
        },
      ],
    };
    render(<NeoLive />);
    const original = askArticle('root-ask');
    expect(within(original).getByRole('status').textContent).toBe(
      'Checking Fictional research’s context…'
    );
    expect(within(askArticle('holder-ask')).queryByRole('status')).toBeNull();
    toggle(within(original).getByText('How this is being handled').closest('details')!);
    const board = await within(original).findByRole('region', { name: 'Concern board' });
    expect(within(board).getByText('Checking root-ask')).toBeTruthy();
    expect(within(board).queryByText('Checking holder-ask')).toBeNull();
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('operation.invoke', {
        name: 'daemon.snapshot',
        input: { limit: 50, includeArchived: false },
      })
    );
    fireEvent.click(within(publicView()).getByRole('button', { name: 'Fictional research' }));
    await waitFor(() => expect(within(askArticle('holder-ask')).getByRole('status')).toBeTruthy());
    expect(within(askArticle('root-ask')).queryByRole('status')).toBeNull();
  });

  it('bases empty-state and scrolling on public entries, retaining manual reading position', async () => {
    asks.value = { ...asks.value, status: 'loading', items: [] };
    publications.value = { ...publications.value, items: [] };
    const { container } = render(<NeoLive />);
    expect(screen.queryByText(/No setup, no folders/)).toBeNull();
    expect(screen.getByText('Loading saved conversation…')).toBeTruthy();
    await act(async () => {
      asks.value = { ...asks.value, status: 'ready' };
    });
    expect(screen.getByText(/No setup, no folders/)).toBeTruthy();
    const main = container.querySelector('main')!;
    Object.defineProperties(main, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    await act(async () => {
      asks.value = { ...asks.value, items: [ask('first')] };
    });
    await waitFor(() => expect(main.scrollTop).toBe(1000));
    fireEvent.scroll(main);
    expect(screen.queryByText(/No setup, no folders/)).toBeNull();
    main.scrollTop = 0;
    fireEvent.scroll(main);
    await act(async () => {
      asks.value = { ...asks.value, items: [ask('second')] };
    });
    await waitFor(() => expect(publicView().textContent).toContain('second'));
    expect(main.scrollTop).toBe(0);
    main.scrollTop = 800;
    fireEvent.scroll(main);
    await act(async () => {
      asks.value = { ...asks.value, items: [ask('third')] };
    });
    await waitFor(() => expect(main.scrollTop).toBe(1000));
  });
});

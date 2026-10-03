import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingUserQuestion, SessionState } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { SessionStore } from '../../lib/session-store.ts';
import { connectionState } from '../../lib/state.ts';
import { NeoLive } from '../NeoLive.tsx';

const useNeoMock = vi.hoisted(() => vi.fn());
const transport = vi.hoisted(() => ({ hub: null as unknown }));
vi.mock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => transport.hub,
    getHubIfConnected: () => transport.hub,
  },
}));
vi.mock('../NeoComposer.tsx', () => ({
  NeoComposer: (props: { draft: string; onDraft: (value: string) => void }) => (
    <textarea
      aria-label="Composer draft"
      value={props.draft}
      onInput={(event) => props.onDraft(event.currentTarget.value)}
    />
  ),
}));
vi.mock('../NeoConversation.tsx', () => ({
  NeoConversation: () => <p>Public fictional conversation</p>,
}));
vi.mock('../../islands/ToastContainer.tsx', () => ({ default: () => null }));

const root = 'neo:550e8400-e29b-41d4-a716-446655440000';
const work = (id: string, status: NeoWork['status'] = 'queued', concernId = 'a'): NeoWork => ({
  id,
  requestKey: id,
  concernId,
  originSessionId: root,
  originMessageId: `ask-${id}`,
  title: `Title ${id}`,
  instruction: `Instruction ${id}`,
  targetSessionId: null,
  sessionId: status === 'proposed' ? null : `worker-${id}`,
  status,
  report: status === 'reported' ? `Report ${id}` : null,
  createdAt: 1,
  updatedAt: 1,
});
const pending = (id: string, toolUseId = `question-${id}`): PendingUserQuestion => ({
  toolUseId,
  askedAt: 1,
  inputOrigin: { sessionId: `worker-${id}`, messageId: id },
  questions: [
    {
      header: 'Fictional choice',
      question: `Choose ${id}`,
      multiSelect: false,
      options: [{ label: 'Plan A', description: 'Fictional' }],
    },
  ],
});
const native = (id: string, question: PendingUserQuestion | null, revision = 1) =>
  ({
    sessionInfo: { id: `worker-${id}`, metadata: {} },
    daemonEpoch: 'fictional',
    revision,
    agentState: question
      ? { status: 'waiting_for_input', pendingQuestion: question }
      : { status: 'idle' },
  }) as SessionState;
type Handler = (state: SessionState, context: { channel: string }) => void;
let states: Map<string, SessionState>;
let handlers: Map<string, Set<Handler>>;
let connections: Set<(status: string) => void>;
let request: ReturnType<typeof vi.fn>;
let join: ReturnType<typeof vi.fn>;
let leave: ReturnType<typeof vi.fn>;
let select: ReturnType<typeof vi.spyOn>;
let destroy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  connectionState.value = 'connected';
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 1120px)',
  }));
  states = new Map(
    ['a', 'b', 'c'].map((id) => [`worker-${id}`, native(id, id === 'c' ? null : pending(id))])
  );
  handlers = new Map();
  connections = new Set();
  join = vi.fn();
  leave = vi.fn();
  select = vi.spyOn(SessionStore.prototype, 'select');
  destroy = vi.spyOn(SessionStore.prototype, 'destroy');
  request = vi.fn(
    async (method: string, input: { sessionId?: string; subscriptionId?: string }) => {
      if (method === 'state.session') return states.get(input.sessionId!);
      if (method === 'liveQuery.subscribe') return { subscriptionId: input.subscriptionId };
      if (method === 'message.count') return { count: 0 };
      return { success: true };
    }
  );
  transport.hub = {
    request,
    joinChannel: join,
    leaveChannel: leave,
    onEvent: (name: string, handler: Handler) => {
      const listeners = handlers.get(name) ?? new Set();
      listeners.add(handler);
      handlers.set(name, listeners);
      return () => listeners.delete(handler);
    },
    onConnection: (handler: (status: string) => void) => {
      connections.add(handler);
      return () => connections.delete(handler);
    },
  };
});
afterEach(async () => {
  cleanup();
  await waitFor(() => expect(connections.size).toBe(0));
  expect([...handlers.values()].every((listeners) => listeners.size === 0)).toBe(true);
  vi.restoreAllMocks();
});
const push = (state: SessionState) =>
  act(() => {
    const id = state.sessionInfo?.id;
    if (!id) throw new Error('Missing fictional session');
    states.set(id, state);
    for (const listener of handlers.get('state.session') ?? [])
      listener(state, { channel: `session:${id}` });
  });
const renderLive = () => {
  const snapshot = {
    ok: true,
    sessionId: root,
    concerns: ['a', 'b'].map((id) => ({
      id,
      title: `Concern ${id}`,
      summary: 'Summary',
      context: 'Context',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    })),
    work: [
      work('a'),
      work('b', 'queued', 'b'),
      work('c'),
      work('p', 'proposed'),
      work('r', 'reported'),
    ],
    consultations: [],
  };
  const model = signal({
    sessionId: root,
    selectedId: null as string | null,
    snapshot,
    viewSnapshot: snapshot,
    viewPublicConversation: {
      conversationId: root.slice(4),
      status: 'ready',
      entries: [],
      hasEarlier: false,
      hasMore: false,
    },
    store: {
      sessionInfo: signal({ metadata: {} }),
      sdkMessages: signal([]),
      messagesLoaded: signal(true),
      activeSessionId: signal(root),
      loadErrorKind: signal(null),
      agentState: signal({ status: 'idle' }),
      error: signal(null),
      hasMoreMessages: signal(false),
      isWorking: signal(false),
      refresh: vi.fn(),
      destroy: vi.fn(),
    },
    busyWork: null,
    error: null,
    publicAuthors: new Set<string>(),
    setError: vi.fn(),
    open: vi.fn(),
    act: vi.fn(),
    send: vi.fn(),
    retry: vi.fn(),
    asks: { retry: vi.fn() },
    publications: { refresh: vi.fn() },
  });
  useNeoMock.mockImplementation(() => model.value);
  return { ...render(<NeoLive />), model };
};
const card = (id: string) => screen.getByRole('article', { name: `Title ${id}` });
const detail = () => screen.getByRole('region', { name: 'Selected work' });

describe('NeoLive public question ownership', () => {
  it('keeps every native choice visible beside a selected detail with one retained observer per work', async () => {
    const { model } = renderLive();
    await screen.findByText('Choose a');
    await screen.findByText('Choose b');
    expect(within(card('a')).getByText('Choose a')).toBeTruthy();
    expect(within(card('b')).getByText('Choose b')).toBeTruthy();
    expect(select).toHaveBeenCalledTimes(3);
    expect(join).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('article', { name: 'Title c' })).toBeNull();
    expect(screen.getByRole('button', { name: 'View details for Title c' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View details for Title r' })).toBeTruthy();
    fireEvent.click(within(card('a')).getByRole('button', { name: /Other/ }));
    fireEvent.input(within(card('a')).getByRole('textbox'), {
      target: { value: 'Unsaved choice A' },
    });
    fireEvent.input(screen.getByRole('textbox', { name: 'Composer draft' }), {
      target: { value: 'Composer stays' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Title a' }));
    await waitFor(() =>
      expect(within(detail()).getByRole('textbox').getAttribute('placeholder')).toBeTruthy()
    );
    expect((within(detail()).getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      'Unsaved choice A'
    );
    expect(screen.getAllByText('Choose a')).toHaveLength(1);
    expect(screen.getAllByText('Choose b')).toHaveLength(1);
    expect(within(card('b')).getByText('Choose b')).toBeTruthy();
    expect(select).toHaveBeenCalledTimes(3);
    expect(destroy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back to scenes' }));
    await waitFor(() =>
      expect((within(card('a')).getByRole('textbox') as HTMLTextAreaElement).value).toBe(
        'Unsaved choice A'
      )
    );
    expect(
      (screen.getByRole('textbox', { name: 'Composer draft' }) as HTMLTextAreaElement).value
    ).toBe('Composer stays');
    fireEvent.click(screen.getByRole('button', { name: 'View details for Title r' }));
    expect(await within(detail()).findByText('Report r')).toBeTruthy();
    expect(screen.getAllByText('Choose a')).toHaveLength(1);
    await waitFor(() => expect(screen.getAllByText('Choose b')).toHaveLength(1));
    fireEvent.click(within(card('b')).getByRole('button', { name: 'Stop work' }));
    expect(model.value.act).toHaveBeenCalledWith('b', 'cancel');
  });
  it('promotes and demotes questions using both native origin IDs without taking a second owner', async () => {
    renderLive();
    await screen.findByText('Choose a');
    const wrong = {
      ...pending('c'),
      inputOrigin: { sessionId: 'worker-c', messageId: 'someone-else' },
    };
    push(native('c', wrong, 2));
    expect(screen.queryByText('Choose c')).toBeNull();
    push(native('c', pending('c'), 3));
    await screen.findByText('Choose c');
    expect(within(card('c')).getByText('Choose c')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'View details for Title c' })).toBeNull();
    push(native('c', null, 4));
    await waitFor(() => expect(screen.queryByText('Choose c')).toBeNull());
    expect(screen.getByRole('button', { name: 'View details for Title c' })).toBeTruthy();
    expect(select).toHaveBeenCalledTimes(3);
    expect(destroy).not.toHaveBeenCalled();
  });
  it('binds native answers to the current tool and releases observers outside the selected scope', async () => {
    const { model } = renderLive();
    await screen.findByText('Choose a');
    push(native('a', pending('a', 'question-A2'), 2));
    await waitFor(() =>
      expect(within(card('a')).getByRole('button', { name: /^Plan A/ })).toBeTruthy()
    );
    fireEvent.click(within(card('a')).getByRole('button', { name: /^Plan A/ }));
    fireEvent.click(within(card('a')).getByRole('button', { name: 'Submit Response' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        'question.respond',
        {
          sessionId: 'worker-a',
          toolUseId: 'question-A2',
          responses: [{ questionIndex: 0, selectedLabels: ['Plan A'], customText: undefined }],
        },
        { timeout: 30000 }
      )
    );
    act(() => {
      model.value = { ...model.value, selectedId: 'b' };
    });
    await waitFor(() => expect(screen.queryByText('Choose a')).toBeNull());
    await waitFor(() => expect(screen.getAllByText('Choose b')).toHaveLength(1));
    await waitFor(() => expect(leave).toHaveBeenCalledWith('session:worker-a'));
    expect(leave).toHaveBeenCalledWith('session:worker-c');
  });
});

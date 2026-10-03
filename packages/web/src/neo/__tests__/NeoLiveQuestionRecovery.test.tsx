import type { PendingUserQuestion, SessionState } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { signal } from '@preact/signals';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../../lib/session-store.ts';
import { connectionState } from '../../lib/state.ts';
import { NeoLive } from '../NeoLive.tsx';
import { projectNeoConcernBoard } from '../neo-concern-board.ts';
import { projectNeoScenes } from '../neo-scenes.ts';

const useNeoMock = vi.hoisted(() => vi.fn());
const transport = vi.hoisted(() => ({ hub: null as unknown }));
vi.mock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => transport.hub,
    getHubIfConnected: () => transport.hub,
  },
}));
vi.mock('../NeoComposer.tsx', () => ({ NeoComposer: () => <textarea aria-label="Draft" /> }));
vi.mock('../NeoConversation.tsx', () => ({ NeoConversation: () => <p>Durable conversation</p> }));
vi.mock('../../islands/ToastContainer.tsx', () => ({ default: () => null }));
vi.mock('../../components/space/AgentOverlayChat.tsx', () => ({
  AgentOverlayChat: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="neo-chat-panel" data-session-id={sessionId} />
  ),
}));

const root = 'neo:550e8400-e29b-41d4-a716-446655440000';
const work: NeoWork = {
  id: 'fictional-work',
  requestKey: 'fictional-work',
  concernId: null,
  originSessionId: root,
  originMessageId: 'fictional-ask',
  title: 'Fictional work',
  instruction: 'Fictional bounded work',
  targetSessionId: null,
  sessionId: 'worker-A',
  status: 'queued',
  report: null,
  createdAt: 1,
  updatedAt: 1,
};
const question = (sessionId: string): PendingUserQuestion => ({
  toolUseId: `question-${sessionId}`,
  askedAt: 1,
  inputOrigin: { sessionId, messageId: work.id },
  questions: [
    {
      header: 'Fictional choice',
      question: `Choose ${sessionId}`,
      multiSelect: false,
      options: [{ label: 'Plan A', description: 'Fictional option' }],
    },
  ],
});
const state = (sessionId: string, waiting = false): SessionState =>
  ({
    sessionInfo: { id: sessionId, metadata: {} },
    daemonEpoch: 'fictional',
    revision: 1,
    agentState: waiting
      ? { status: 'waiting_for_input', pendingQuestion: question(sessionId) }
      : { status: 'idle' },
  }) as SessionState;
let fail: boolean;
let delayed: Promise<SessionState> | null;
let waiting: boolean;
let request: ReturnType<typeof vi.fn>;
let listeners: Set<unknown>;
let connections: Set<unknown>;
let select: ReturnType<typeof vi.spyOn>;
let destroy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  connectionState.value = 'connected';
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  fail = true;
  delayed = null;
  waiting = false;
  listeners = new Set();
  connections = new Set();
  select = vi.spyOn(SessionStore.prototype, 'select');
  destroy = vi.spyOn(SessionStore.prototype, 'destroy');
  request = vi.fn(
    async (method: string, input: { sessionId?: string; subscriptionId?: string }) => {
      if (method === 'state.session') {
        if (input.sessionId === 'worker-A' && fail) throw new Error('Fictional timeout');
        return input.sessionId === 'worker-A' && delayed
          ? delayed
          : state(input.sessionId!, waiting);
      }
      if (method === 'liveQuery.subscribe') return { subscriptionId: input.subscriptionId };
      if (method === 'message.count') return { count: 0 };
      return { success: true };
    }
  );
  transport.hub = {
    request,
    joinChannel: vi.fn(),
    leaveChannel: vi.fn(),
    onEvent: (_: string, callback: unknown) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    onConnection: (callback: unknown) => {
      connections.add(callback);
      return () => connections.delete(callback);
    },
  };
});
afterEach(async () => {
  cleanup();
  await waitFor(() => expect(connections.size).toBe(0));
  expect(listeners.size).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount() {
  const snapshot = { ok: true, sessionId: root, concerns: [], work: [work], consultations: [] };
  const model = signal({
    sessionId: root,
    snapshot,
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
    setError: vi.fn(),
    open: vi.fn(),
    act: vi.fn(),
    send: vi.fn(),
    retry: vi.fn(),
    asks: { retry: vi.fn() },
    publications: { refresh: vi.fn() },
  });
  useNeoMock.mockImplementation(() => model.value);
  const view = render(<NeoLive />);
  const sheet = screen.queryByRole('button', { name: /^Your work/ });
  if (sheet) fireEvent.click(sheet);
  return { ...view, model };
}
const attention = () => screen.getByRole('region', { name: 'Needs your attention' });
const compact = () => screen.getByRole('button', { name: 'Open chat for Fictional work' });

describe('NeoLive native question failure attention', () => {
  it('makes a hidden load failure visible and retains its owner and attention until explicit retry completes', async () => {
    const { model } = mount();
    const alert = await screen.findByRole('alert');
    expect(within(attention()).getByRole('alert')).toBe(alert);
    expect(screen.queryByRole('region', { name: 'In progress' })).toBeNull();
    expect(select).toHaveBeenCalledTimes(1);
    fail = false;
    let release!: (value: SessionState) => void;
    delayed = new Promise((resolve) => {
      release = resolve;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check questions again' }));
    await waitFor(() => expect(select).toHaveBeenCalledTimes(2));
    expect(within(attention()).getByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open chat for Fictional work' })).toBeNull();
    expect(select.mock.contexts[0]).toBe(select.mock.contexts[1]);
    expect(destroy).not.toHaveBeenCalled();
    await act(async () => {
      release(state('worker-A'));
    });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(
      within(await screen.findByRole('region', { name: 'In progress' })).getByRole('button', {
        name: 'Open chat for Fictional work',
      })
    ).toBe(compact());
    expect(screen.queryByRole('region', { name: 'Needs your attention' })).toBeNull();
    expect(model.value.act).not.toHaveBeenCalled();
  });

  it('recovers a real current native question and leads it to its chat without answering inline', async () => {
    const { model } = mount();
    await screen.findByRole('alert');
    fail = false;
    waiting = true;
    fireEvent.click(screen.getByRole('button', { name: 'Check questions again' }));
    await waitFor(() =>
      expect(within(attention()).getByText('Waiting for your answer')).toBeTruthy()
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(select).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: /Submit Response|Send answer/ })).toBeNull();
    fireEvent.click(within(attention()).getByRole('button', { name: 'Answer in chat' }));
    expect(screen.getByTestId('neo-chat-panel').dataset.sessionId).toBe('worker-A');
    expect(request.mock.calls.some(([method]) => method === 'question.respond')).toBe(false);
    expect(request.mock.calls.some(([method]) => method === 'operation.invoke')).toBe(false);
    expect(model.value.act).not.toHaveBeenCalled();
  });

  it('cannot reintroduce a failed old observer after a work-session replacement', async () => {
    const { model } = mount();
    await screen.findByRole('alert');
    fail = false;
    let release!: (value: SessionState) => void;
    delayed = new Promise((resolve) => {
      release = resolve;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check questions again' }));
    await waitFor(() => expect(select).toHaveBeenCalledTimes(2));
    act(() => {
      const snapshot = { ...model.value.snapshot, work: [{ ...work, sessionId: 'worker-B' }] };
      model.value = { ...model.value, snapshot };
    });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    await act(async () => {
      release(state('worker-A', true));
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Waiting for your answer')).toBeNull();
    expect(compact()).toBeTruthy();
    expect(select).toHaveBeenCalledTimes(3);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['queued', 'worker-A', 'attention', 'Could not check questions'],
    ['queued', 'worker-B', 'running', 'Handed to HyperNeo'],
    ['reported', 'worker-A', 'outcomes', 'Response ready'],
    ['cancelled', 'worker-A', 'outcomes', 'Stopped'],
    ['proposed', 'worker-A', 'attention', 'Your call'],
  ] as const)(
    'promotes only queued current-owned failure: %s/%s',
    (status, owner, group, label) => {
      const board = projectNeoConcernBoard(
        { ok: true, sessionId: root, concerns: [], work: [{ ...work, status }], consultations: [] },
        null,
        null
      );
      const scenes = projectNeoScenes(board, new Map(), new Map([[work.id, owner]]));
      expect(scenes?.[group]).toHaveLength(1);
      expect(scenes?.[group][0].label).toBe(label);
      expect(scenes?.counts.total).toBe(1);
    }
  );
});

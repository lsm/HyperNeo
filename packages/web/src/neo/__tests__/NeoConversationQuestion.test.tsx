import type { PendingUserQuestion, SessionState } from '@hyperneo/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../../lib/session-store.ts';
import { connectionState } from '../../lib/state.ts';
import { toastsSignal } from '../../lib/toast.ts';
import { NeoConversation } from '../NeoConversation.tsx';

const controls = vi.hoisted(() => ({ hub: null as unknown }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => controls.hub,
    getHubIfConnected: () => controls.hub,
  },
}));

type Handler = (value: unknown, context: { channel: string }) => void;
const sessionA = 'neo-A';
const sessionB = 'neo-B';
const pending = (toolUseId = 'choice-A'): PendingUserQuestion => ({
  toolUseId,
  askedAt: 1,
  questions: [
    {
      question: 'Which draft should I keep?',
      header: 'Draft',
      multiSelect: false,
      options: [
        { label: 'Keep draft', description: 'Do not run it' },
        { label: 'Discard', description: 'Do not change it' },
      ],
    },
  ],
});
const waiting = (id: string, toolUseId = 'choice-A', revision = 1): SessionState =>
  ({
    sessionInfo: { id, metadata: {} },
    agentState: { status: 'waiting_for_input', pendingQuestion: pending(toolUseId) },
    revision,
    daemonEpoch: 'qa',
  }) as SessionState;

let request: ReturnType<typeof vi.fn>;
let states: Map<string, SessionState>;
let events: Map<string, Set<Handler>>;
let connections: Set<(state: string) => void>;
let failure: Error | 'disconnected' | null;
let delayed: { sessionId: string; promise: Promise<unknown> } | null;
let stores: SessionStore[];
const push = (id: string, state: SessionState) => {
  states.set(id, state);
  for (const handler of events.get('state.session') ?? [])
    handler(state, { channel: `session:${id}` });
};

beforeEach(() => {
  connectionState.value = 'connected';
  toastsSignal.value = [];
  states = new Map([
    [sessionA, waiting(sessionA)],
    [sessionB, waiting(sessionB)],
  ]);
  events = new Map();
  connections = new Set();
  stores = [];
  failure = null;
  delayed = null;
  request = vi.fn(async (method: string, data: { sessionId?: string; subscriptionId?: string }) => {
    if (method === 'state.session') return states.get(data.sessionId ?? '');
    if (method === 'liveQuery.subscribe') return { subscriptionId: data.subscriptionId };
    if (method === 'question.respond' || method === 'question.cancel') {
      const pendingReply = delayed;
      if (pendingReply && pendingReply.sessionId === data.sessionId) return pendingReply.promise;
      if (failure === 'disconnected') return null;
      if (failure instanceof Error) throw failure;
    }
    return { success: true };
  });
  controls.hub = {
    request,
    joinChannel: vi.fn(),
    leaveChannel: vi.fn(),
    onEvent: (method: string, handler: Handler) => {
      const handlers = events.get(method) ?? new Set();
      handlers.add(handler);
      events.set(method, handlers);
      return () => handlers.delete(handler);
    },
    onConnection: (handler: (state: string) => void) => {
      connections.add(handler);
      return () => connections.delete(handler);
    },
  };
});

afterEach(async () => {
  cleanup();
  await Promise.all(stores.map((store) => store.destroy()));
  await waitFor(() => expect(connections.size).toBe(0));
});

async function mount(id = sessionA) {
  const store = new SessionStore();
  stores.push(store);
  await act(async () => store.select(id));
  const refresh = vi.spyOn(store, 'refresh');
  const view = render(<NeoConversation store={store} sessionId={id} />);
  await screen.findByRole('button', { name: /Keep draft/ });
  return { store, view, refresh };
}

const option = () => screen.findByRole('button', { name: /Keep draft/ });
const submit = () => screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement;
const action = (respond: boolean) =>
  screen.getByRole('button', { name: respond ? 'Send answer' : 'Skip' });

describe('NeoConversation native question feedback', () => {
  it.each([
    ['respond', false],
    ['cancel', false],
    ['respond', true],
    ['cancel', true],
  ] as const)(
    'keeps native %s retryable and clears current feedback after success',
    async (kind, disconnected) => {
      failure = disconnected ? 'disconnected' : new Error('Native reply rejected');
      const { store, refresh } = await mount();
      if (kind === 'respond') fireEvent.click(await option());
      fireEvent.click(action(kind === 'respond'));
      const expected = disconnected
        ? 'Connection lost. Reconnect and try again.'
        : 'Native reply rejected';
      expect((await screen.findByRole('alert')).textContent).toBe(expected);
      expect(toastsSignal.value).toEqual([]);
      expect(action(kind === 'respond').hasAttribute('disabled')).toBe(false);
      expect(request).toHaveBeenCalledWith(
        kind === 'respond' ? 'question.respond' : 'question.cancel',
        expect.objectContaining({ sessionId: sessionA, toolUseId: 'choice-A' }),
        expect.anything()
      );
      failure = null;
      fireEvent.click(action(kind === 'respond'));
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      expect(store.agentState.value.status).toBe('waiting_for_input');
    }
  );

  it.each(['question', 'recipient'] as const)(
    'does not let an old reply replace current feedback after a %s change',
    async (change) => {
      let rejectOld!: (cause: unknown) => void;
      delayed = { sessionId: sessionA, promise: new Promise((_, reject) => (rejectOld = reject)) };
      const { store, view } = await mount();
      fireEvent.click(await option());
      fireEvent.click(submit());
      await waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          'question.respond',
          expect.anything(),
          expect.anything()
        )
      );
      delayed = null;
      if (change === 'question') {
        await act(async () => push(sessionA, waiting(sessionA, 'choice-B', 2)));
      } else {
        await act(async () => store.select(sessionB));
      }
      view.rerender(
        <NeoConversation store={store} sessionId={change === 'question' ? sessionA : sessionB} />
      );
      expect(submit().disabled).toBe(true);
      failure = new Error('Current reply rejected');
      fireEvent.click(await option());
      fireEvent.click(submit());
      expect((await screen.findByRole('alert')).textContent).toBe('Current reply rejected');
      await act(async () => rejectOld(new Error('Stale reply rejected')));
      expect(screen.getByRole('alert').textContent).toBe('Current reply rejected');
    }
  );

  it('does not refresh when a delayed success arrives after unmount', async () => {
    let resolveOld!: (value: unknown) => void;
    delayed = { sessionId: sessionA, promise: new Promise((resolve) => (resolveOld = resolve)) };
    const { view, refresh } = await mount();
    refresh.mockClear();
    fireEvent.click(await option());
    fireEvent.click(submit());
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('question.respond', expect.anything(), expect.anything())
    );
    view.unmount();
    await act(async () => resolveOld({ success: true }));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('ignores a late success after the same question was externally resolved', async () => {
    let resolveOld!: (value: unknown) => void;
    delayed = { sessionId: sessionA, promise: new Promise((resolve) => (resolveOld = resolve)) };
    const { refresh } = await mount();
    fireEvent.click(await option());
    fireEvent.click(submit());
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('question.respond', expect.anything(), expect.anything())
    );
    delayed = null;
    await act(async () =>
      push(sessionA, {
        ...waiting(sessionA),
        revision: 2,
        agentState: { status: 'idle' },
      } as SessionState)
    );
    await act(async () => resolveOld({ success: true }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});

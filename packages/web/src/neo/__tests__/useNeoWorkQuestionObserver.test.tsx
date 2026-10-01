import { act, cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingUserQuestion, SessionState } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { useNeoWorkQuestionObserver } from '../useNeoWorkQuestionObserver.ts';
import { markAllSessionStoresRecovering, SessionStore } from '../../lib/session-store.ts';
import { connectionState } from '../../lib/state.ts';

const controls = vi.hoisted(() => ({ hub: null as unknown }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => controls.hub,
    getHubIfConnected: () => controls.hub,
  },
}));
const work: NeoWork = {
  id: 'work',
  requestKey: 'work',
  concernId: 'fictional',
  originSessionId: 'neo',
  originMessageId: 'ask',
  title: 'Fictional work',
  instruction: 'Bounded work',
  sessionId: 'worker-A',
  status: 'queued',
  report: null,
  createdAt: 1,
  updatedAt: 1,
};
const question = (
  toolUseId = 'question-A',
  sessionId = 'worker-A',
  workId = 'work'
): PendingUserQuestion => ({
  toolUseId,
  askedAt: 1,
  inputOrigin: { sessionId, messageId: workId },
  questions: [
    { question: 'Which fictional draft?', header: 'Draft', multiSelect: false, options: [] },
  ],
});
const waiting = (pending = question(), revision = 1): SessionState =>
  ({
    sessionInfo: { id: pending.inputOrigin!.sessionId, metadata: {} },
    agentState: { status: 'waiting_for_input', pendingQuestion: pending },
    revision,
    daemonEpoch: 'fictional',
  }) as SessionState;
type Handler = (state: SessionState, context: { channel: string }) => void;
let handlers: Map<string, Set<Handler>>;
let connections: Set<(state: string) => void>;
let states: Map<string, SessionState>;
let request: ReturnType<typeof vi.fn>;
let join: ReturnType<typeof vi.fn>;
let leave: ReturnType<typeof vi.fn>;
let initial: Promise<SessionState> | null;
let observed: ReturnType<typeof useNeoWorkQuestionObserver>;
function Probe({ value = work }: { value?: NeoWork }) {
  observed = useNeoWorkQuestionObserver(value);
  return <p aria-label="Observed question">{observed.question?.toolUseId ?? 'none'}</p>;
}
const push = (sessionId: string, state: SessionState) => {
  states.set(sessionId, state);
  for (const handler of handlers.get('state.session') ?? [])
    handler(state, { channel: `session:${sessionId}` });
};
const observedText = () => screen.getByLabelText('Observed question').textContent;
beforeEach(() => {
  connectionState.value = 'connected';
  handlers = new Map();
  connections = new Set();
  states = new Map([
    ['worker-A', waiting()],
    ['worker-B', waiting(question('question-B', 'worker-B'))],
  ]);
  initial = null;
  join = vi.fn();
  leave = vi.fn();
  request = vi.fn(async (method: string, input: { sessionId: string; subscriptionId?: string }) => {
    if (method === 'state.session') return initial ?? states.get(input.sessionId);
    if (method === 'liveQuery.subscribe') return { subscriptionId: input.subscriptionId };
    if (method === 'message.count') return { count: 0 };
    return { success: true };
  });
  controls.hub = {
    request,
    joinChannel: join,
    leaveChannel: leave,
    onEvent: (method: string, handler: Handler) => {
      const list = handlers.get(method) ?? new Set();
      list.add(handler);
      handlers.set(method, list);
      return () => list.delete(handler);
    },
    onConnection: (handler: (state: string) => void) => {
      connections.add(handler);
      return () => connections.delete(handler);
    },
  };
});
afterEach(async () => {
  cleanup();
  await waitFor(() => expect(connections.size).toBe(0));
  expect([...handlers.values()].every((set) => set.size === 0)).toBe(true);
  vi.restoreAllMocks();
});

describe('useNeoWorkQuestionObserver', () => {
  it('keeps the actual store, channel and subscriptions while a new question replaces the old one', async () => {
    const view = render(<Probe />);
    await waitFor(() => expect(observedText()).toBe('question-A'));
    const original = observed.store;
    expect(join).toHaveBeenCalledTimes(1);
    await act(async () => push('worker-A', waiting(question('question-next'), 2)));
    expect(observedText()).toBe('question-next');
    expect(observed.store).toBe(original);
    expect(join).toHaveBeenCalledTimes(1);
    expect(leave).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([method]) => method === 'state.session')).toHaveLength(1);
    view.unmount();
    await waitFor(() => expect(leave).toHaveBeenCalledWith('session:worker-A'));
  });
  it.each(['session', 'message'] as const)(
    'refuses a question attributed to another %s without replacing its store',
    async (part) => {
      render(<Probe />);
      await waitFor(() => expect(observedText()).toBe('question-A'));
      const original = observed.store;
      const wrong =
        part === 'session'
          ? question('wrong', 'worker-B')
          : question('wrong', 'worker-A', 'other-work');
      await act(async () =>
        push('worker-A', { ...waiting(wrong, 2), sessionInfo: waiting().sessionInfo })
      );
      expect(observedText()).toBe('none');
      expect(observed.store).toBe(original);
      expect(join).toHaveBeenCalledTimes(1);
    }
  );
  it.each(['reported', 'failed', 'cancelled'] as const)(
    'withdraws %s work controls without restarting observation',
    async (status) => {
      const view = render(<Probe />);
      await waitFor(() => expect(observedText()).toBe('question-A'));
      const original = observed.store;
      view.rerender(<Probe value={{ ...work, status }} />);
      expect(observedText()).toBe('none');
      expect(observed.store).toBe(original);
      expect(join).toHaveBeenCalledTimes(1);
    }
  );
  it('suspends disconnected and recovering evidence, then observes the recovered snapshot', async () => {
    render(<Probe />);
    await waitFor(() => expect(observedText()).toBe('question-A'));
    const original = observed.store;
    await act(async () => {
      connectionState.value = 'disconnected';
    });
    expect(observedText()).toBe('none');
    await act(async () => {
      connectionState.value = 'connected';
      markAllSessionStoresRecovering();
    });
    expect(observedText()).toBe('none');
    states.set('worker-A', waiting(question('recovered'), 2));
    await act(async () => {
      for (const handler of connections) handler('connected');
    });
    await waitFor(() => expect(observedText()).toBe('recovered'));
    expect(observed.store).toBe(original);
  });
  it('releases the old target and cannot resurrect a delayed snapshot after switching targets', async () => {
    let release!: (value: SessionState) => void;
    initial = new Promise((resolve) => {
      release = resolve;
    });
    const destroy = vi.spyOn(SessionStore.prototype, 'destroy');
    const view = render(<Probe />);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('state.session', { sessionId: 'worker-A' })
    );
    const old = observed.store;
    initial = null;
    view.rerender(<Probe value={{ ...work, sessionId: 'worker-B' }} />);
    await waitFor(() => expect(observedText()).toBe('question-B'));
    expect(observed.store).not.toBe(old);
    await act(async () => release(waiting()));
    expect(observedText()).toBe('question-B');
    await waitFor(() => expect(leave).toHaveBeenCalledWith('session:worker-A'));
    view.unmount();
    await waitFor(() => expect(leave).toHaveBeenCalledWith('session:worker-B'));
    expect(destroy).toHaveBeenCalledTimes(2);
    await Promise.all(destroy.mock.results.map((result) => result.value));
  });
});

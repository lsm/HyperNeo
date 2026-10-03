import type { PendingUserQuestion, SessionState } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { act, cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../../lib/session-store.ts';
import { connectionState } from '../../lib/state.ts';
import { NeoWorkQuestionControls } from '../NeoWorkQuestionControls.tsx';
import { useNeoWorkQuestionObserver } from '../useNeoWorkQuestionObserver.ts';

const transport = vi.hoisted(() => ({ hub: null as unknown }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => transport.hub,
    getHubIfConnected: () => transport.hub,
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
const question = (toolUseId = 'question-A'): PendingUserQuestion => ({
  toolUseId,
  askedAt: 1,
  inputOrigin: { sessionId: 'worker-A', messageId: 'work' },
  questions: [
    {
      header: 'Draft',
      question: toolUseId,
      multiSelect: false,
      options: [{ label: 'Plan A', description: 'Fictional plan' }],
    },
  ],
});
const waiting = (toolUseId = 'question-A', revision = 1): SessionState =>
  ({
    sessionInfo: { id: 'worker-A', metadata: {} },
    agentState: { status: 'waiting_for_input', pendingQuestion: question(toolUseId) },
    revision,
    daemonEpoch: 'fictional',
  }) as SessionState;
type Handler = (state: SessionState, context: { channel: string }) => void;
let handlers: Map<string, Set<Handler>>;
let connections: Set<(state: string) => void>;
let state: SessionState;
let request: ReturnType<typeof vi.fn>;
let join: ReturnType<typeof vi.fn>;
let leave: ReturnType<typeof vi.fn>;
let observed: ReturnType<typeof useNeoWorkQuestionObserver>;
function Owner({ show = true }: { show?: boolean }) {
  observed = useNeoWorkQuestionObserver(work);
  return show ? <NeoWorkQuestionControls work={work} observation={observed} /> : null;
}
const push = (next: SessionState) => {
  state = next;
  for (const handler of handlers.get('state.session') ?? [])
    handler(next, { channel: 'session:worker-A' });
};
const stateRequests = () =>
  request.mock.calls.filter(([method]) => method === 'state.session').length;
const observedQuestion = (id: string) =>
  waitFor(() => expect(observed.question?.toolUseId).toBe(id));
beforeEach(() => {
  connectionState.value = 'connected';
  handlers = new Map();
  connections = new Set();
  state = waiting();
  join = vi.fn();
  leave = vi.fn();
  request = vi.fn(async (method: string, input: { subscriptionId?: string }) => {
    if (method === 'state.session') return state;
    if (method === 'liveQuery.subscribe') return { subscriptionId: input.subscriptionId };
    if (method === 'message.count') return { count: 0 };
    return { success: true };
  });
  transport.hub = {
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

describe('NeoWorkQuestionControls with an existing observation', () => {
  it('remounts controls without creating, joining or destroying a second observation', async () => {
    const destroy = vi.spyOn(SessionStore.prototype, 'destroy');
    const view = render(<Owner />);
    await observedQuestion('question-A');
    const original = observed.store;
    expect(join).toHaveBeenCalledTimes(1);
    expect(stateRequests()).toBe(1);
    view.rerender(<Owner show={false} />);
    expect(observed.store).toBe(original);
    expect(destroy).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
    view.rerender(<Owner />);
    await observedQuestion('question-A');
    expect(observed.store).toBe(original);
    expect(join).toHaveBeenCalledTimes(1);
    expect(stateRequests()).toBe(1);
    view.unmount();
    await waitFor(() => expect(leave).toHaveBeenCalledWith('session:worker-A'));
    expect(destroy).toHaveBeenCalledTimes(1);
    await Promise.all(destroy.mock.results.map((result) => result.value));
  });
  it('follows the current native question without a second store and renders no inline reply', async () => {
    const select = vi.spyOn(SessionStore.prototype, 'select');
    const destroy = vi.spyOn(SessionStore.prototype, 'destroy');
    const view = render(<Owner />);
    await observedQuestion('question-A');
    const original = observed.store;
    await act(async () => push(waiting('question-B', 2)));
    expect(observed.question?.toolUseId).toBe('question-B');
    expect(view.container.querySelector('button, textarea, fieldset')).toBeNull();
    await act(async () => push({ ...waiting('question-B', 3), agentState: { status: 'idle' } }));
    expect(observed.question).toBeNull();
    expect(observed.store).toBe(original);
    expect(select).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
  });
  it('shows the native session error', async () => {
    const view = render(<Owner />);
    await observedQuestion('question-A');
    await act(async () =>
      push({
        ...waiting('question-A', 2),
        agentState: { status: 'idle' },
        error: { message: 'Fictional session failure', occurredAt: 2 },
      } as SessionState)
    );
    expect(screen.getByRole('alert').textContent).toContain('Fictional session failure');
    view.unmount();
  });
});

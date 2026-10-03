import type { PendingUserQuestion, SessionState } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { act, cleanup, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../../lib/session-store.ts';
import { connectionState } from '../../lib/state.ts';
import { NeoWorkQuestionResource } from '../NeoWorkQuestionResource.tsx';

const transport = vi.hoisted(() => ({ hub: null as unknown }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => transport.hub,
    getHubIfConnected: () => transport.hub,
  },
}));
const work: NeoWork = {
  id: 'work-A',
  requestKey: 'work-A',
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
const question = (id = 'question-A'): PendingUserQuestion => ({
  toolUseId: id,
  askedAt: 1,
  inputOrigin: { sessionId: 'worker-A', messageId: work.id },
  questions: [
    {
      header: 'Draft',
      question: id,
      multiSelect: false,
      options: [{ label: 'Plan A', description: 'Fictional' }],
    },
  ],
});
const waiting = (id = 'question-A', revision = 1): SessionState =>
  ({
    sessionInfo: { id: 'worker-A', metadata: {} },
    agentState: { status: 'waiting_for_input', pendingQuestion: question(id) },
    revision,
    daemonEpoch: 'fictional',
  }) as SessionState;
type Handler = (state: SessionState, context: { channel: string }) => void;
let state: SessionState;
let handlers: Map<string, Set<Handler>>;
let connections: Set<(status: string) => void>;
let request: ReturnType<typeof vi.fn>;
let join: ReturnType<typeof vi.fn>;
let leave: ReturnType<typeof vi.fn>;
let targets: HTMLElement[];
const push = (next: SessionState) => {
  state = next;
  for (const handler of handlers.get('state.session') ?? [])
    handler(next, { channel: 'session:worker-A' });
};
const stateRequests = () =>
  request.mock.calls.filter(([method]) => method === 'state.session').length;
beforeEach(() => {
  connectionState.value = 'connected';
  state = waiting();
  handlers = new Map();
  connections = new Set();
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
      const set = handlers.get(method) ?? new Set();
      set.add(handler);
      handlers.set(method, set);
      return () => set.delete(handler);
    },
    onConnection: (handler: (status: string) => void) => {
      connections.add(handler);
      return () => connections.delete(handler);
    },
  };
  targets = [document.createElement('section'), document.createElement('section')];
  targets.forEach((target) => document.body.append(target));
});
afterEach(async () => {
  cleanup();
  await waitFor(() => expect(connections.size).toBe(0));
  expect([...handlers.values()].every((set) => set.size === 0)).toBe(true);
  targets.forEach((target) => target.remove());
  vi.restoreAllMocks();
});

describe('NeoWorkQuestionResource', () => {
  it('replaces the listener without announcing removal and cleans up through the latest listener', async () => {
    const first = vi.fn();
    const next = vi.fn();
    const select = vi.spyOn(SessionStore.prototype, 'select');
    const destroy = vi.spyOn(SessionStore.prototype, 'destroy');
    const view = render(<NeoWorkQuestionResource work={work} onQuestion={first} />);
    await waitFor(() => expect(first).toHaveBeenLastCalledWith(work.id, question()));
    first.mockClear();
    view.rerender(<NeoWorkQuestionResource work={work} onQuestion={next} />);
    await waitFor(() => expect(next).toHaveBeenLastCalledWith(work.id, question()));
    expect(first).not.toHaveBeenCalled();
    expect(next.mock.calls.some(([, value]) => value === null)).toBe(false);
    expect(select).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(next).toHaveBeenLastCalledWith(work.id, null));
    expect(next.mock.calls.filter(([, value]) => value === null)).toHaveLength(1);
    await waitFor(() => expect(leave).toHaveBeenCalledWith('session:worker-A'));
    expect(destroy).toHaveBeenCalledTimes(1);
  });
  it('keeps one observer while its visible slot changes', async () => {
    const select = vi.spyOn(SessionStore.prototype, 'select');
    const destroy = vi.spyOn(SessionStore.prototype, 'destroy');
    const changed = vi.fn();
    const view = render(
      <NeoWorkQuestionResource work={work} target={targets[0]} onQuestion={changed} />
    );
    await waitFor(() => expect(changed).toHaveBeenCalledWith(work.id, question()));
    view.rerender(<NeoWorkQuestionResource work={work} target={null} onQuestion={changed} />);
    expect(destroy).not.toHaveBeenCalled();
    view.rerender(<NeoWorkQuestionResource work={work} target={targets[1]} onQuestion={changed} />);
    expect(select).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledTimes(1);
    expect(stateRequests()).toBe(1);
    expect(changed).toHaveBeenLastCalledWith(work.id, question());
    view.unmount();
    await waitFor(() => expect(leave).toHaveBeenCalledWith('session:worker-A'));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith(work.id, null);
    await Promise.all(destroy.mock.results.map((result) => result.value));
  });
  it('reports a newly attributed question to its listener', async () => {
    const changed = vi.fn();
    render(<NeoWorkQuestionResource work={work} onQuestion={changed} />);
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith(work.id, question()));
    await act(async () => push(waiting('question-B', 2)));
    expect(changed).toHaveBeenLastCalledWith(work.id, question('question-B'));
    await act(async () => push({ ...waiting('question-B', 3), agentState: { status: 'idle' } }));
    expect(changed).toHaveBeenLastCalledWith(work.id, null);
  });
});

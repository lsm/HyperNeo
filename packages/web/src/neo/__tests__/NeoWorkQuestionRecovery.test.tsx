import type { PendingUserQuestion, SessionState } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
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
  id: 'fictional-work',
  requestKey: 'fictional-work',
  concernId: null,
  originSessionId: 'neo',
  originMessageId: 'ask',
  title: 'Fictional choice',
  instruction: 'Bounded fictional work',
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
      header: 'Choice',
      question: `Choose ${sessionId}`,
      multiSelect: false,
      options: [{ label: 'Plan A', description: 'Fictional plan' }],
    },
  ],
});
const waiting = (sessionId: string): SessionState =>
  ({
    sessionInfo: { id: sessionId, metadata: {} },
    agentState: { status: 'waiting_for_input', pendingQuestion: question(sessionId) },
    daemonEpoch: 'fictional',
    revision: 1,
  }) as SessionState;
let changed: ReturnType<typeof vi.fn<(id: string, question: PendingUserQuestion | null) => void>>;
const lastQuestion = () => changed.mock.calls.at(-1)?.[1] as PendingUserQuestion | null | undefined;
let failures: boolean;
let request: ReturnType<typeof vi.fn>;
let listeners: Set<unknown>;
let connections: Set<unknown>;
let join: ReturnType<typeof vi.fn>;
let leave: ReturnType<typeof vi.fn>;
let delayed: Promise<SessionState> | null;
beforeEach(() => {
  changed = vi.fn();
  connectionState.value = 'connected';
  failures = true;
  delayed = null;
  listeners = new Set();
  connections = new Set();
  join = vi.fn();
  leave = vi.fn();
  request = vi.fn(
    async (method: string, input: { sessionId?: string; subscriptionId?: string }) => {
      if (method === 'state.session') {
        if (failures) throw new Error('Fictional timeout');
        return input.sessionId === 'worker-A' && delayed ? delayed : waiting(input.sessionId!);
      }
      if (method === 'liveQuery.subscribe') return { subscriptionId: input.subscriptionId };
      if (method === 'message.count') return { count: 0 };
      return { success: true };
    }
  );
  transport.hub = {
    request,
    joinChannel: join,
    leaveChannel: leave,
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
});
describe('NeoWorkQuestionResource native load recovery', () => {
  it('retries the actual failed store and reports the recovered question without starting work', async () => {
    const select = vi.spyOn(SessionStore.prototype, 'select');
    const destroy = vi.spyOn(SessionStore.prototype, 'destroy');
    const view = render(<NeoWorkQuestionResource work={work} onQuestion={changed} />);
    expect((await screen.findByRole('alert')).textContent).toContain('taking longer than expected');
    expect(lastQuestion() ?? null).toBeNull();
    failures = false;
    fireEvent.click(screen.getByRole('button', { name: 'Check questions again' }));
    await waitFor(() => expect(lastQuestion()?.toolUseId).toBe('question-worker-A'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(select).toHaveBeenCalledTimes(2);
    expect(select.mock.contexts[0]).toBe(select.mock.contexts[1]);
    expect(destroy).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Submit Response|Send answer/ })).toBeNull();
    expect(request.mock.calls.some(([method]) => method === 'operation.invoke')).toBe(false);
    view.unmount();
    await waitFor(() => expect(leave).toHaveBeenCalledWith('session:worker-A'));
    expect(destroy).toHaveBeenCalledTimes(1);
  });
  it('does not retry automatically and disables its explicit retry while disconnected', async () => {
    render(<NeoWorkQuestionResource work={work} onQuestion={changed} />);
    await screen.findByRole('alert');
    expect(request.mock.calls.filter(([method]) => method === 'state.session')).toHaveLength(1);
    await act(async () => {
      connectionState.value = 'disconnected';
    });
    expect(
      (screen.getByRole('button', { name: 'Check questions again' }) as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Check questions again' }));
    expect(request.mock.calls.filter(([method]) => method === 'state.session')).toHaveLength(1);
  });
  it('cannot revive an old question from a delayed retry after the work session changes', async () => {
    const view = render(<NeoWorkQuestionResource work={work} onQuestion={changed} />);
    await screen.findByRole('alert');
    failures = false;
    let release!: (state: SessionState) => void;
    delayed = new Promise((resolve) => {
      release = resolve;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check questions again' }));
    await waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === 'state.session')).toHaveLength(2)
    );
    view.rerender(
      <NeoWorkQuestionResource work={{ ...work, sessionId: 'worker-B' }} onQuestion={changed} />
    );
    await waitFor(() => expect(lastQuestion()?.toolUseId).toBe('question-worker-B'));
    await act(async () => {
      release(waiting('worker-A'));
    });
    expect(lastQuestion()?.toolUseId).toBe('question-worker-B');
    expect(changed.mock.calls.some(([, value]) => value?.toolUseId === 'question-worker-A')).toBe(
      false
    );
    await waitFor(() => expect(leave).toHaveBeenCalledWith('session:worker-A'));
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingUserQuestion, SessionState } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { NeoWorkQuestion } from '../NeoWorkQuestion.tsx';
import { SessionStore } from '../../lib/session-store.ts';
import { connectionState } from '../../lib/state.ts';

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
let failures: boolean;
let request: ReturnType<typeof vi.fn>;
let listeners: Set<unknown>;
let connections: Set<unknown>;
let join: ReturnType<typeof vi.fn>;
let leave: ReturnType<typeof vi.fn>;
let delayed: Promise<SessionState> | null;
beforeEach(() => {
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
describe('NeoWorkQuestion native load recovery', () => {
  it('retries the actual failed store and binds the recovered answer without starting work', async () => {
    const select = vi.spyOn(SessionStore.prototype, 'select');
    const destroy = vi.spyOn(SessionStore.prototype, 'destroy');
    const view = render(<NeoWorkQuestion work={work} />);
    expect((await screen.findByRole('alert')).textContent).toContain('taking longer than expected');
    expect(screen.queryByText('Choose worker-A')).toBeNull();
    failures = false;
    fireEvent.click(screen.getByRole('button', { name: 'Check questions again' }));
    await screen.findByText('Choose worker-A');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(select).toHaveBeenCalledTimes(2);
    expect(select.mock.contexts[0]).toBe(select.mock.contexts[1]);
    expect(destroy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Plan A/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit Response' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        'question.respond',
        {
          sessionId: 'worker-A',
          toolUseId: 'question-worker-A',
          responses: [{ questionIndex: 0, selectedLabels: ['Plan A'], customText: undefined }],
        },
        { timeout: 30000 }
      )
    );
    expect(request.mock.calls.some(([method]) => method === 'operation.invoke')).toBe(false);
    view.unmount();
    await waitFor(() => expect(leave).toHaveBeenCalledWith('session:worker-A'));
    expect(destroy).toHaveBeenCalledTimes(1);
  });
  it('does not retry automatically and disables its explicit retry while disconnected', async () => {
    render(<NeoWorkQuestion work={work} />);
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
    const view = render(<NeoWorkQuestion work={work} />);
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
    view.rerender(<NeoWorkQuestion work={{ ...work, sessionId: 'worker-B' }} />);
    await screen.findByText('Choose worker-B');
    await act(async () => {
      release(waiting('worker-A'));
    });
    expect(screen.queryByText('Choose worker-A')).toBeNull();
    expect(screen.getAllByText('Choose worker-B')).toHaveLength(1);
    await waitFor(() => expect(leave).toHaveBeenCalledWith('session:worker-A'));
  });
});

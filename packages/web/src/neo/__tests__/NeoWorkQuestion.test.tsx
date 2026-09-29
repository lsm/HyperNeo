import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionState, PendingUserQuestion } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { NeoWorkQuestion } from '../NeoWorkQuestion.tsx';
import { NeoWorkCard } from '../NeoWorkCard.tsx';
import { markAllSessionStoresRecovering } from '../../lib/session-store.ts';

const controls = vi.hoisted(() => ({
  hub: null as unknown,
}));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => controls.hub,
    getHubIfConnected: () => controls.hub,
  },
}));
vi.mock('../../lib/toast.ts', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../components/chat/MarkdownRenderer.tsx', () => ({ default: () => null }));
import { connectionState } from '../../lib/state.ts';

type Handler = (value: unknown, context: { channel: string }) => void;
const work: NeoWork = {
  id: 'work-A',
  requestKey: 'A',
  concernId: 'project-A',
  originSessionId: 'neo',
  originMessageId: 'ask-A',
  title: 'Review only this draft',
  instruction: 'No execution',
  sessionId: 'manager-A',
  targetSessionId: 'manager-A',
  status: 'queued',
  report: null,
  createdAt: 1,
  updatedAt: 1,
};
const pending = (
  id = 'choice-A',
  sessionId = 'manager-A',
  workId = 'work-A'
): PendingUserQuestion => ({
  toolUseId: id,
  askedAt: 1,
  inputOrigin: { sessionId, messageId: workId },
  questions: [
    {
      question: 'Which draft should I keep?',
      header: 'Draft',
      multiSelect: false,
      options: [
        { label: 'Keep draft', description: 'Do not run it' },
        { label: 'Stop', description: 'Do not change it' },
      ],
    },
  ],
});
const waiting = (question = pending()): SessionState =>
  ({
    sessionInfo: { id: question.inputOrigin!.sessionId, metadata: {} },
    agentState: { status: 'waiting_for_input', pendingQuestion: question },
    revision: 1,
    daemonEpoch: 'qa',
  }) as SessionState;
let request: ReturnType<typeof vi.fn>;
let join: ReturnType<typeof vi.fn>;
let leave: ReturnType<typeof vi.fn>;
let handlers: Map<string, Set<Handler>>;
let states: Map<string, SessionState>;
let failure: Error | null;
let disconnectedResult: boolean;
let connections: Set<(state: string) => void>;
let initial: Promise<SessionState> | null;
const push = (sessionId: string, state: SessionState) => {
  states.set(sessionId, state);
  for (const handler of handlers.get('state.session') ?? [])
    handler(state, { channel: `session:${sessionId}` });
};
beforeEach(() => {
  connectionState.value = 'connected';
  handlers = new Map();
  states = new Map([['manager-A', waiting()]]);
  connections = new Set();
  failure = null;
  disconnectedResult = false;
  initial = null;
  join = vi.fn();
  leave = vi.fn();
  request = vi.fn(
    async (
      method: string,
      data: { sessionId: string; subscriptionId?: string; toolUseId?: string }
    ) => {
      if (method === 'state.session') return initial ?? states.get(data.sessionId);
      if (method === 'liveQuery.subscribe') return { subscriptionId: data.subscriptionId };
      if (method === 'message.count') return { count: 0 };
      if (method === 'question.respond' || method === 'question.cancel') {
        if (failure) throw failure;
        if (disconnectedResult) return null;
        const old = states.get(data.sessionId)!;
        push(data.sessionId, {
          ...old,
          revision: old.revision! + 1,
          agentState: { status: 'idle' },
        });
        return { success: true };
      }
      return { success: true };
    }
  );
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
});
const choice = () => screen.findByRole('button', { name: /Keep draft/ });
const submit = () => screen.getByRole('button', { name: 'Submit Response' }) as HTMLButtonElement;
const expectRequest = (method: string, data: unknown) =>
  waitFor(() => expect(request).toHaveBeenCalledWith(method, data, { timeout: 30000 }));

describe('NeoWorkQuestion native controls', () => {
  it('answers from the actual work card through the exact native RPC and releases its subscriptions', async () => {
    const view = render(
      <NeoWorkCard work={work} busy={false} disabled={false} onAction={vi.fn()} />
    );
    fireEvent.click(await choice());
    fireEvent.click(submit());
    await expectRequest('question.respond', {
      sessionId: 'manager-A',
      toolUseId: 'choice-A',
      responses: [{ questionIndex: 0, selectedLabels: ['Keep draft'], customText: undefined }],
    });
    await waitFor(() => expect(screen.queryByText('A quick choice')).toBeNull());
    expect(screen.getByRole('link', { name: /Inspect execution/ })).toBeTruthy();
    view.unmount();
    await waitFor(() => expect(leave).toHaveBeenCalledWith('session:manager-A'));
    expect([...handlers.values()].every((list) => list.size === 0)).toBe(true);
  });
  it('sends a custom answer through the same native question controls', async () => {
    render(<NeoWorkQuestion work={work} />);
    await choice();
    fireEvent.click(screen.getByRole('button', { name: /Other/ }));
    fireEvent.input(screen.getByPlaceholderText('Enter your response...'), {
      target: { value: 'Keep the alternate draft' },
    });
    fireEvent.click(submit());
    await expectRequest(
      'question.respond',
      expect.objectContaining({
        toolUseId: 'choice-A',
        responses: [
          { questionIndex: 0, selectedLabels: [], customText: 'Keep the alternate draft' },
        ],
      })
    );
  });
  it('skips the pending native question without invoking a work operation', async () => {
    render(<NeoWorkQuestion work={work} />);
    await choice();
    fireEvent.click(screen.getByRole('button', { name: 'Skip Question' }));
    await expectRequest('question.cancel', { sessionId: 'manager-A', toolUseId: 'choice-A' });
    expect(request.mock.calls.some(([method]) => method === 'operation.invoke')).toBe(false);
  });
  it.each(['question.respond', 'question.cancel'])(
    'keeps failures visible and retryable for %s',
    async (method) => {
      failure = new Error('Native answer rejected');
      render(<NeoWorkQuestion work={work} />);
      fireEvent.click(await choice());
      fireEvent.click(
        method === 'question.respond'
          ? submit()
          : screen.getByRole('button', { name: 'Skip Question' })
      );
      expect((await screen.findByRole('alert')).textContent).toContain('Native answer rejected');
      expect(screen.getByText('A quick choice')).toBeTruthy();
      failure = null;
      fireEvent.click(
        method === 'question.respond'
          ? submit()
          : screen.getByRole('button', { name: 'Skip Question' })
      );
      await waitFor(() => expect(screen.queryByText('A quick choice')).toBeNull());
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    }
  );
  it('does not claim a reply when the native call loses its connection', async () => {
    disconnectedResult = true;
    render(<NeoWorkQuestion work={work} />);
    fireEvent.click(await choice());
    fireEvent.click(submit());
    expect((await screen.findByRole('alert')).textContent).toContain('Connection lost');
    expect(screen.getByText('A quick choice')).toBeTruthy();
  });
  it('follows native question changes without retaining a previous selection', async () => {
    render(<NeoWorkQuestion work={work} />);
    fireEvent.click(await choice());
    expect(submit().disabled).toBe(false);
    await act(async () => push('manager-A', { ...waiting(pending('choice-next')), revision: 2 }));
    expect(submit().disabled).toBe(true);
    fireEvent.click(await choice());
    fireEvent.click(submit());
    await expectRequest('question.respond', expect.objectContaining({ toolUseId: 'choice-next' }));
  });
  it('shows only the exactly attributed choice when two jobs share the recipient', async () => {
    const other = { ...work, id: 'work-B', title: 'Different job' };
    const view = render(
      <>
        <NeoWorkQuestion key="work-A" work={work} />
        <NeoWorkQuestion key="work-B" work={other} />
      </>
    );
    await choice();
    expect(screen.getAllByText('A quick choice')).toHaveLength(1);
    await act(async () =>
      push('manager-A', { ...waiting(pending('choice-B', 'manager-A', 'work-B')), revision: 2 })
    );
    view.rerender(
      <>
        <NeoWorkQuestion key="work-B" work={other} />
      </>
    );
    expect(await choice()).toBeTruthy();
    expect(leave).not.toHaveBeenCalled();
    fireEvent.click(await choice());
    fireEvent.click(submit());
    await expectRequest('question.respond', expect.objectContaining({ toolUseId: 'choice-B' }));
    view.unmount();
    await waitFor(() => expect(leave).toHaveBeenCalledWith('session:manager-A'));
  });
  it('cannot act on disconnected or recovering native state', async () => {
    const view = render(<NeoWorkQuestion work={work} />);
    await choice();
    await act(async () => {
      connectionState.value = 'disconnected';
    });
    view.rerender(<NeoWorkQuestion work={work} />);
    expect(screen.queryByText('A quick choice')).toBeNull();
    await act(async () => {
      connectionState.value = 'connected';
      markAllSessionStoresRecovering();
    });
    expect(screen.queryByText('A quick choice')).toBeNull();
    states.set('manager-A', { ...waiting(), revision: 2 });
    await act(async () => {
      for (const handler of connections) handler('connected');
    });
    await choice();
    expect(request.mock.calls.some(([method]) => method === 'question.respond')).toBe(false);
  });
  it('does not let a delayed old recipient snapshot reappear after a target switch', async () => {
    let release!: (state: SessionState) => void;
    initial = new Promise((resolve) => {
      release = resolve;
    });
    const view = render(<NeoWorkQuestion work={work} />);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('state.session', { sessionId: 'manager-A' })
    );
    expect(screen.queryByText('A quick choice')).toBeNull();
    initial = null;
    states.set('manager-B', waiting(pending('choice-B', 'manager-B')));
    view.rerender(
      <NeoWorkQuestion work={{ ...work, sessionId: 'manager-B', targetSessionId: 'manager-B' }} />
    );
    await choice();
    await act(async () => release(waiting()));
    fireEvent.click(await choice());
    fireEvent.click(submit());
    await expectRequest(
      'question.respond',
      expect.objectContaining({ sessionId: 'manager-B', toolUseId: 'choice-B' })
    );
    expect(
      request.mock.calls.some(
        ([method, data]) => method === 'question.respond' && data.sessionId === 'manager-A'
      )
    ).toBe(false);
  });
  it.each(['reported', 'failed', 'cancelled'] as const)(
    'withdraws choice controls for %s work',
    async (status) => {
      const view = render(<NeoWorkQuestion work={work} />);
      await choice();
      view.rerender(<NeoWorkQuestion work={{ ...work, status }} />);
      expect(screen.queryByText('A quick choice')).toBeNull();
      expect(request.mock.calls.some(([method]) => method === 'question.respond')).toBe(false);
    }
  );
});

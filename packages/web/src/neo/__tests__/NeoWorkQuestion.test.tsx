import type { PendingUserQuestion, SessionState } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestionPrompt } from '../../components/QuestionPrompt.tsx';
import { markAllSessionStoresRecovering } from '../../lib/session-store.ts';
import { toast } from '../../lib/toast.ts';
import { NeoWorkCard } from '../NeoWorkCard.tsx';
import { NeoWorkQuestion } from '../NeoWorkQuestion.tsx';
import { NeoWorkQuestionResource } from '../NeoWorkQuestionResource.tsx';

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
const sessionId = 'manager-A';
const work: NeoWork = {
  id: 'work-A',
  requestKey: 'A',
  concernId: 'project-A',
  originSessionId: 'neo',
  originMessageId: 'ask-A',
  title: 'Review only this draft',
  instruction: 'No execution',
  sessionId,
  targetSessionId: sessionId,
  status: 'queued',
  report: null,
  createdAt: 1,
  updatedAt: 1,
};
const pending = (
  id = 'choice-A',
  recipient = sessionId,
  workId = work.id
): PendingUserQuestion => ({
  toolUseId: id,
  askedAt: 1,
  inputOrigin: { sessionId: recipient, messageId: workId },
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
let failure: unknown;
let disconnectedResult: boolean;
let connections: Set<(state: string) => void>;
let initial: Promise<SessionState> | null;
const push = (sessionId: string, state: SessionState) => {
  states.set(sessionId, state);
  const context = { channel: `session:${sessionId}` };
  for (const handler of handlers.get('state.session') ?? []) handler(state, context);
};
beforeEach(() => {
  connectionState.value = 'connected';
  handlers = new Map();
  states = new Map([['manager-A', waiting()]]);
  connections = new Set();
  failure = null;
  disconnectedResult = false;
  vi.mocked(toast.error).mockClear();
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
  vi.restoreAllMocks();
});
const choice = () => screen.findByRole('button', { name: /Keep draft/ });
const actionButton = (respond: boolean) =>
  screen.getByRole('button', { name: respond ? 'Submit Response' : 'Skip Question' });
const lastQuestion = (listener: ReturnType<typeof vi.fn>, workId = work.id) =>
  listener.mock.calls.filter(([id]) => id === workId).at(-1)?.[1] as
    | PendingUserQuestion
    | null
    | undefined;

describe('NeoWorkQuestion native controls', () => {
  it('shows the actual SessionStore error instead of generic read fallback text', async () => {
    states.set(sessionId, {
      ...waiting(),
      agentState: { status: 'idle' },
      error: { message: 'This session is no longer available.', occurredAt: 2 },
    });
    render(<NeoWorkQuestion work={work} />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This session is no longer available.'
    );
    expect(screen.queryByText('Could not check this agent’s questions.')).toBeNull();
  });
  it('observes from the actual work card without inline reply controls and releases its subscriptions', async () => {
    const view = render(
      <NeoWorkCard work={work} busy={false} disabled={false} onAction={vi.fn()} onOpen={vi.fn()} />
    );
    await waitFor(() => expect(join).toHaveBeenCalledWith('session:manager-A'));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('state.session', { sessionId: 'manager-A' })
    );
    expect(
      screen.queryByRole('button', { name: /Keep draft|Submit Response|Send answer/ })
    ).toBeNull();
    view.unmount();
    await waitFor(() => expect(leave).toHaveBeenCalledWith('session:manager-A'));
    expect([...handlers.values()].every((list) => list.size === 0)).toBe(true);
    expect(
      request.mock.calls.some(
        ([method]) => method === 'question.respond' || method === 'question.cancel'
      )
    ).toBe(false);
  });
  it.each(['respond', 'cancel'] as const)(
    'keeps a legacy native %s retryable after disconnect',
    async (action) => {
      const respond = action === 'respond';
      disconnectedResult = true;
      const onResolved = vi.fn();
      render(
        <QuestionPrompt sessionId={sessionId} pendingQuestion={pending()} onResolved={onResolved} />
      );
      const button = () => actionButton(respond) as HTMLButtonElement;
      if (respond) fireEvent.click(await choice());
      fireEvent.click(button());
      await waitFor(() => expect(button().disabled).toBe(false));
      expect(request.mock.calls[0]?.[0]).toBe(respond ? 'question.respond' : 'question.cancel');
      expect(onResolved).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith('Connection lost. Reconnect and try again.');
      disconnectedResult = false;
      failure = 'Native answer rejected';
      fireEvent.click(button());
      await waitFor(() => expect(button().disabled).toBe(false));
      expect(onResolved).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenLastCalledWith('Could not send your choice. Try again.');
      failure = null;
      fireEvent.click(button());
      await waitFor(() =>
        expect(onResolved).toHaveBeenCalledWith(
          respond ? 'submitted' : 'cancelled',
          respond
            ? [{ questionIndex: 0, selectedLabels: ['Keep draft'], customText: undefined }]
            : []
        )
      );
      expect(request).toHaveBeenCalledTimes(3);
    }
  );
});

describe('NeoWorkQuestionResource native observation', () => {
  it('reports only the exactly attributed question when two jobs share the recipient', async () => {
    const other = { ...work, id: 'work-B', title: 'Different job' };
    const changed = vi.fn();
    const view = render(
      <>
        <NeoWorkQuestionResource key="work-A" work={work} onQuestion={changed} />
        <NeoWorkQuestionResource key="work-B" work={other} onQuestion={changed} />
      </>
    );
    await waitFor(() => expect(lastQuestion(changed)?.toolUseId).toBe('choice-A'));
    expect(lastQuestion(changed, 'work-B') ?? null).toBeNull();
    await act(async () =>
      push('manager-A', { ...waiting(pending('choice-B', 'manager-A', 'work-B')), revision: 2 })
    );
    view.rerender(
      <>
        <NeoWorkQuestionResource key="work-B" work={other} onQuestion={changed} />
      </>
    );
    await waitFor(() => expect(lastQuestion(changed, 'work-B')?.toolUseId).toBe('choice-B'));
    expect(leave).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(leave).toHaveBeenCalledWith('session:manager-A'));
  });
  it('withdraws the question on disconnected or recovering native state', async () => {
    const changed = vi.fn();
    const view = render(<NeoWorkQuestionResource work={work} onQuestion={changed} />);
    await waitFor(() => expect(lastQuestion(changed)?.toolUseId).toBe('choice-A'));
    await act(async () => {
      connectionState.value = 'disconnected';
    });
    view.rerender(<NeoWorkQuestionResource work={work} onQuestion={changed} />);
    expect(lastQuestion(changed)).toBeNull();
    await act(async () => {
      connectionState.value = 'connected';
      markAllSessionStoresRecovering();
    });
    expect(lastQuestion(changed)).toBeNull();
    states.set('manager-A', { ...waiting(), revision: 2 });
    await act(async () => {
      for (const handler of connections) handler('connected');
    });
    await waitFor(() => expect(lastQuestion(changed)?.toolUseId).toBe('choice-A'));
  });
  it('does not let a delayed old recipient snapshot reappear after a target switch', async () => {
    let release!: (state: SessionState) => void;
    initial = new Promise((resolve) => {
      release = resolve;
    });
    const changed = vi.fn();
    const view = render(<NeoWorkQuestionResource work={work} onQuestion={changed} />);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('state.session', { sessionId: 'manager-A' })
    );
    expect(lastQuestion(changed) ?? null).toBeNull();
    initial = null;
    states.set('manager-B', waiting(pending('choice-B', 'manager-B')));
    view.rerender(
      <NeoWorkQuestionResource
        work={{ ...work, sessionId: 'manager-B', targetSessionId: 'manager-B' }}
        onQuestion={changed}
      />
    );
    await waitFor(() => expect(lastQuestion(changed)?.toolUseId).toBe('choice-B'));
    await act(async () => release(waiting()));
    expect(lastQuestion(changed)?.toolUseId).toBe('choice-B');
    expect(changed.mock.calls.some(([, value]) => value?.toolUseId === 'choice-A')).toBe(false);
  });
  it.each(['reported', 'failed', 'cancelled'] as const)(
    'withdraws the question for %s work',
    async (status) => {
      const changed = vi.fn();
      const view = render(<NeoWorkQuestionResource work={work} onQuestion={changed} />);
      await waitFor(() => expect(lastQuestion(changed)?.toolUseId).toBe('choice-A'));
      view.rerender(<NeoWorkQuestionResource work={{ ...work, status }} onQuestion={changed} />);
      await waitFor(() => expect(lastQuestion(changed)).toBeNull());
    }
  );
});

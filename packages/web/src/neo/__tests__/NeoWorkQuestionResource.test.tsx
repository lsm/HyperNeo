import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingUserQuestion, SessionState } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { NeoWorkQuestionResource } from '../NeoWorkQuestionResource.tsx';
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
let answer: Promise<unknown> | null;
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
  answer = null;
  join = vi.fn();
  leave = vi.fn();
  request = vi.fn(async (method: string, input: { subscriptionId?: string }) => {
    if (method === 'state.session') return state;
    if (method === 'liveQuery.subscribe') return { subscriptionId: input.subscriptionId };
    if (method === 'message.count') return { count: 0 };
    if (method === 'question.respond') return answer ?? { success: true };
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
  it('does not re-arm untouched draft autosave when the daemon echoes a new response array', async () => {
    const originalRequest = request.getMockImplementation() as (
      method: string,
      input: { subscriptionId?: string }
    ) => Promise<unknown>;
    request.mockImplementation(
      async (
        method: string,
        input: { subscriptionId?: string; draftResponses?: PendingUserQuestion['draftResponses'] }
      ) => {
        if (method === 'question.saveDraft') {
          expect(Array.isArray(input.draftResponses)).toBe(true);
          const pending = state.agentState;
          expect(pending.status).toBe('waiting_for_input');
          if (pending.status === 'waiting_for_input')
            push({
              ...state,
              revision: (state.revision ?? 0) + 1,
              agentState: {
                ...pending,
                pendingQuestion: {
                  ...pending.pendingQuestion,
                  draftResponses: structuredClone(input.draftResponses),
                },
              },
            } as SessionState);
          return { success: true };
        }
        return originalRequest(method, input);
      }
    );
    render(<NeoWorkQuestionResource work={work} />);
    await screen.findByText('question-A');
    const saves = () => request.mock.calls.filter(([method]) => method === 'question.saveDraft');
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(state.revision).toBe(2);
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 1100)));
    expect(saves()).toHaveLength(1);
    expect(state.revision).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: /^Plan A/ }));
    await waitFor(() => expect(saves()).toHaveLength(2));
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 1100)));
    expect(saves()).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: 'Submit Response' }).getAttribute('disabled')
    ).toBeNull();
  });
  it('retains selection while a visible slot is absent, without another observer', async () => {
    const select = vi.spyOn(SessionStore.prototype, 'select');
    const destroy = vi.spyOn(SessionStore.prototype, 'destroy');
    const changed = vi.fn();
    const view = render(
      <NeoWorkQuestionResource work={work} target={targets[0]} onQuestion={changed} />
    );
    await screen.findByText('question-A');
    fireEvent.click(screen.getByRole('button', { name: /^Plan A/ }));
    view.rerender(<NeoWorkQuestionResource work={work} target={null} onQuestion={changed} />);
    expect(screen.queryByText('question-A')).toBeNull();
    expect(destroy).not.toHaveBeenCalled();
    view.rerender(<NeoWorkQuestionResource work={work} target={targets[1]} onQuestion={changed} />);
    await screen.findByText('question-A');
    expect(targets[0].textContent).toBe('');
    expect(
      (screen.getByRole('button', { name: 'Submit Response' }) as HTMLButtonElement).disabled
    ).toBe(false);
    expect(screen.getAllByText('A quick choice')).toHaveLength(1);
    expect(select).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledTimes(1);
    expect(stateRequests()).toBe(1);
    expect(changed).toHaveBeenCalledWith(work.id, question());
    fireEvent.click(screen.getByRole('button', { name: 'Submit Response' }));
    await waitFor(() => expect(stateRequests()).toBe(2));
    expect(request).toHaveBeenCalledWith(
      'question.respond',
      {
        sessionId: 'worker-A',
        toolUseId: 'question-A',
        responses: [{ questionIndex: 0, selectedLabels: ['Plan A'], customText: undefined }],
      },
      { timeout: 30000 }
    );
    view.unmount();
    await waitFor(() => expect(leave).toHaveBeenCalledWith('session:worker-A'));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith(work.id, null);
    await Promise.all(destroy.mock.results.map((result) => result.value));
  });
  it('moves an unsaved custom draft between actual visible slots', async () => {
    const view = render(<NeoWorkQuestionResource work={work} target={targets[0]} />);
    await screen.findByText('question-A');
    fireEvent.click(screen.getByRole('button', { name: /Other/ }));
    fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Unsaved fictional draft' } });
    expect(request.mock.calls.filter(([method]) => method === 'question.saveDraft')).toEqual([]);
    view.rerender(<NeoWorkQuestionResource work={work} target={targets[1]} />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      'Unsaved fictional draft'
    );
    expect(targets[0].querySelector('textarea')).toBeNull();
    expect(targets[1].querySelector('textarea')).toBeTruthy();
    view.rerender(<NeoWorkQuestionResource work={work} target={targets[0]} />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      'Unsaved fictional draft'
    );
    expect(join).toHaveBeenCalledTimes(1);
  });
  it('never lends a prior tool draft to a newly attributed question', async () => {
    const changed = vi.fn();
    render(<NeoWorkQuestionResource work={work} onQuestion={changed} />);
    await screen.findByText('question-A');
    fireEvent.click(screen.getByRole('button', { name: /Other/ }));
    fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Old draft' } });
    await act(async () => push(waiting('question-B', 2)));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('question-B')).toBeTruthy();
    expect(changed).toHaveBeenLastCalledWith(work.id, question('question-B'));
    fireEvent.click(screen.getByRole('button', { name: /^Plan A/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit Response' }));
    await waitFor(() => expect(stateRequests()).toBe(2));
    expect(request.mock.calls.find(([method]) => method === 'question.respond')?.[1]).toMatchObject(
      { toolUseId: 'question-B' }
    );
  });
  it.each(['success', 'failure'] as const)(
    'ignores a late %s from a replaced slot',
    async (outcome) => {
      let accept!: (value: unknown) => void;
      let reject!: (cause: Error) => void;
      answer = new Promise((resolve, refuse) => {
        accept = resolve;
        reject = refuse;
      });
      const view = render(<NeoWorkQuestionResource work={work} target={targets[0]} />);
      await screen.findByText('question-A');
      fireEvent.click(screen.getByRole('button', { name: /^Plan A/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Submit Response' }));
      await waitFor(() =>
        expect(request.mock.calls.some(([method]) => method === 'question.respond')).toBe(true)
      );
      view.rerender(<NeoWorkQuestionResource work={work} target={null} />);
      await act(async () => push(waiting('question-B', 2)));
      view.rerender(<NeoWorkQuestionResource work={work} target={targets[1]} />);
      await screen.findByText('question-B');
      await act(async () => {
        if (outcome === 'success') accept({ success: true });
        else reject(new Error('Old request failed'));
      });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByText('question-B')).toBeTruthy();
      expect(stateRequests()).toBe(1);
      expect(join).toHaveBeenCalledTimes(1);
    }
  );
});

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingUserQuestion, SessionState } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { NeoWorkQuestion } from '../NeoWorkQuestion.tsx';
import { SessionStore } from '../../lib/session-store.ts';

const controls = vi.hoisted(() => ({
  hub: null as unknown,
  holdHub: false,
  releaseHub: null as null | (() => void),
  getHubCalls: 0,
}));

vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => {
      controls.getHubCalls += 1;
      if (controls.holdHub) {
        await new Promise<void>((resolve) => {
          controls.releaseHub = resolve;
        });
      }
      return controls.hub;
    },
    getHubIfConnected: () => controls.hub,
  },
}));
vi.mock('../../lib/toast.ts', () => ({ toast: { error: vi.fn() } }));

import { connectionState } from '../../lib/state.ts';

type Handler = (value: unknown, context?: { channel?: string }) => void;
type RequestData = { sessionId?: string; subscriptionId?: string; toolUseId?: string };

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

const pending = (toolUseId: string, question: string, option: string): PendingUserQuestion => ({
  toolUseId,
  askedAt: 1,
  inputOrigin: { sessionId, messageId: work.id },
  questions: [
    {
      question,
      header: 'Plan',
      multiSelect: false,
      options: [{ label: option, description: 'Use this plan' }],
    },
  ],
});

const waiting = (question: PendingUserQuestion, revision: number): SessionState =>
  ({
    sessionInfo: { id: sessionId, metadata: {} },
    agentState: { status: 'waiting_for_input', pendingQuestion: question },
    revision,
    daemonEpoch: 'lifetime-test',
  }) as SessionState;

let request: ReturnType<typeof vi.fn>;
let join: ReturnType<typeof vi.fn>;
let leave: ReturnType<typeof vi.fn>;
let handlers: Map<string, Set<Handler>>;
let connections: Set<(state: string) => void>;
let states: Map<string, SessionState>;

const pushState = (state: SessionState) => {
  states.set(sessionId, state);
  for (const handler of handlers.get('state.session') ?? []) {
    handler(state, { channel: `session:${sessionId}` });
  }
};

beforeEach(() => {
  connectionState.value = 'connected';
  controls.holdHub = false;
  controls.releaseHub = null;
  controls.getHubCalls = 0;
  handlers = new Map();
  connections = new Set();
  states = new Map([
    [
      sessionId,
      waiting(pending('choice-A', 'Which draft should I keep?', 'Keep the first draft'), 1),
    ],
  ]);
  join = vi.fn(() => Promise.resolve());
  leave = vi.fn();
  request = vi.fn(async (method: string, data: RequestData = {}) => {
    if (method === 'state.session') return states.get(data.sessionId ?? '');
    if (method === 'liveQuery.subscribe') return { subscriptionId: data.subscriptionId };
    if (method === 'question.respond') {
      const state = states.get(data.sessionId ?? sessionId)!;
      pushState({ ...state, revision: (state.revision ?? 1) + 1, agentState: { status: 'idle' } });
      return { success: true };
    }
    return { success: true };
  });
  controls.hub = {
    request,
    joinChannel: join,
    leaveChannel: leave,
    onEvent: (method: string, handler: Handler) => {
      const listeners = handlers.get(method) ?? new Set<Handler>();
      listeners.add(handler);
      handlers.set(method, listeners);
      return () => listeners.delete(handler);
    },
    onConnection: (handler: (state: string) => void) => {
      connections.add(handler);
      return () => connections.delete(handler);
    },
  };
});

afterEach(async () => {
  cleanup();
  controls.releaseHub?.();
  await waitFor(() =>
    expect([...handlers.values()].every((listeners) => listeners.size === 0)).toBe(true)
  );
  await waitFor(() => expect(connections.size).toBe(0));
  vi.restoreAllMocks();
});

describe('NeoWorkQuestion resource lifetime', () => {
  it('keeps one real recipient store while the attributed native question changes', async () => {
    const select = vi.spyOn(SessionStore.prototype, 'select');
    const destroy = vi.spyOn(SessionStore.prototype, 'destroy');
    const view = render(<NeoWorkQuestion work={work} />);

    expect(await screen.findByText('Which draft should I keep?')).toBeTruthy();
    await waitFor(() =>
      expect(request.mock.calls.some(([method]) => method === 'liveQuery.subscribe')).toBe(true)
    );
    expect(select).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledTimes(1);

    await act(async () =>
      pushState(waiting(pending('choice-B', 'Which plan should run?', 'Keep the newer plan'), 2))
    );
    expect(await screen.findByText('Which plan should run?')).toBeTruthy();
    expect(screen.queryByText('Which draft should I keep?')).toBeNull();
    expect(select).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Keep the newer plan/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit Response' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        'question.respond',
        {
          sessionId,
          toolUseId: 'choice-B',
          responses: [
            { questionIndex: 0, selectedLabels: ['Keep the newer plan'], customText: undefined },
          ],
        },
        { timeout: 30000 }
      )
    );
    expect(select).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledTimes(1);

    view.unmount();
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(leave).toHaveBeenCalledWith(`session:${sessionId}`));
    expect([...handlers.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(connections.size).toBe(0);
  });

  it('cleans up a real store when its deferred hub source resolves after unmount', async () => {
    controls.holdHub = true;
    const select = vi.spyOn(SessionStore.prototype, 'select');
    const destroy = vi.spyOn(SessionStore.prototype, 'destroy');
    const view = render(<NeoWorkQuestion work={work} />);
    await waitFor(() => expect(controls.getHubCalls).toBe(1));

    view.unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
    controls.releaseHub?.();
    await act(async () => {
      await Promise.all([
        select.mock.results[0]?.value as Promise<void>,
        destroy.mock.results[0]?.value as Promise<void>,
      ]);
    });

    expect(select).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledWith(`session:${sessionId}`);
    expect(request.mock.calls.some(([method]) => method === 'liveQuery.unsubscribe')).toBe(true);
    expect([...handlers.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(connections.size).toBe(0);
    expect(screen.queryByText('Which draft should I keep?')).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/preact';
import type { SessionState } from '@hyperneo/shared';
import { useSessionQuestionState } from '../useSessionQuestionState';

const mockRequest = vi.fn();
const mockJoinRoom = vi.fn();
const mockLeaveRoom = vi.fn();

type HandlerWithContext = (data: unknown, context: { channel?: string }) => void;
const sessionStateHandlers: HandlerWithContext[] = [];

const mockOnEvent = vi.fn(
  (eventName: string, handler: (data: unknown, context?: { channel?: string }) => void) => {
    if (eventName === 'state.session') {
      sessionStateHandlers.push(handler as HandlerWithContext);
    }
    return () => {};
  }
);

vi.mock('../useMessageHub.ts', () => ({
  useMessageHub: () => ({
    request: mockRequest,
    onEvent: mockOnEvent,
    joinRoom: mockJoinRoom,
    leaveRoom: mockLeaveRoom,
  }),
}));

function makeIdleSessionState(): SessionState {
  return {
    agentState: { status: 'idle' },
    sessionInfo: null,
    commandsData: { availableCommands: [] },
    error: null,
  } as unknown as SessionState;
}

function makeWaitingSessionState(toolUseId: string): SessionState {
  return {
    agentState: {
      status: 'waiting_for_input',
      pendingQuestion: {
        toolUseId,
        questions: [
          {
            question: 'What should I do?',
            header: 'Decision needed',
            options: [],
            multiSelect: false,
          },
        ],
        askedAt: 1000,
      },
    },
    sessionInfo: null,
    commandsData: { availableCommands: [] },
    error: null,
  } as unknown as SessionState;
}

function fireSessionEvent(channel: string, data: unknown): void {
  for (const handler of sessionStateHandlers) {
    handler(data, { channel });
  }
}

describe('useSessionQuestionState', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockOnEvent.mockClear();
    mockJoinRoom.mockReset();
    mockLeaveRoom.mockReset();
    sessionStateHandlers.length = 0;
    mockRequest.mockResolvedValue(makeIdleSessionState());
  });

  afterEach(() => {
    cleanup();
  });

  it('returns empty state when sessionId is undefined', () => {
    const { result } = renderHook(() => useSessionQuestionState(undefined));

    expect(result.current.pendingQuestion).toBeNull();
    expect(result.current.resolvedQuestions.size).toBe(0);
    expect(typeof result.current.onQuestionResolved).toBe('function');

    expect(mockJoinRoom).not.toHaveBeenCalled();
  });

  it('joins the session channel when sessionId is provided', () => {
    renderHook(() => useSessionQuestionState('session-abc'));

    expect(mockJoinRoom).toHaveBeenCalledWith('session:session-abc');
  });

  it('leaves the channel on unmount', () => {
    const { unmount } = renderHook(() => useSessionQuestionState('session-abc'));

    unmount();

    expect(mockLeaveRoom).toHaveBeenCalledWith('session:session-abc');
  });

  it('fetches initial state and sets pendingQuestion when waiting_for_input', async () => {
    mockRequest.mockResolvedValue(makeWaitingSessionState('tool-001'));

    const { result } = renderHook(() => useSessionQuestionState('session-abc'));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.pendingQuestion).not.toBeNull();
    expect(result.current.pendingQuestion?.toolUseId).toBe('tool-001');
  });

  it('fetches initial state and resolvedQuestions from session metadata', async () => {
    const resolvedQuestion = {
      question: { toolUseId: 'tool-old', questions: [], askedAt: 500 },
      state: 'submitted' as const,
      responses: [{ questionIndex: 0, selectedLabels: ['Yes'], customText: undefined }],
      resolvedAt: 600,
    };

    mockRequest.mockResolvedValue({
      ...makeIdleSessionState(),
      sessionInfo: {
        metadata: {
          resolvedQuestions: {
            'tool-old': resolvedQuestion,
          },
        },
      },
    } as unknown as SessionState);

    const { result } = renderHook(() => useSessionQuestionState('session-abc'));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.resolvedQuestions.size).toBe(1);
    expect(result.current.resolvedQuestions.get('tool-old')).toEqual(resolvedQuestion);
  });

  it('updates pendingQuestion on state.session event from the correct channel', async () => {
    const { result } = renderHook(() => useSessionQuestionState('session-abc'));

    act(() => {
      fireSessionEvent('session:session-abc', makeWaitingSessionState('tool-abc'));
    });

    await waitFor(() => {
      expect(result.current.pendingQuestion?.toolUseId).toBe('tool-abc');
    });
  });

  it('ignores state.session events from OTHER channels (cross-session contamination fix)', async () => {
    const { result: leaderResult } = renderHook(() => useSessionQuestionState('leader-session'));
    const { result: workerResult } = renderHook(() => useSessionQuestionState('worker-session'));

    act(() => {
      fireSessionEvent('session:worker-session', makeWaitingSessionState('tool-worker'));
    });

    await waitFor(() => {
      expect(workerResult.current.pendingQuestion?.toolUseId).toBe('tool-worker');
    });
    expect(leaderResult.current.pendingQuestion).toBeNull();
  });

  it('clears pendingQuestion when session transitions out of waiting_for_input', async () => {
    mockRequest.mockResolvedValue(makeWaitingSessionState('tool-001'));

    const { result } = renderHook(() => useSessionQuestionState('session-abc'));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.pendingQuestion).not.toBeNull();

    await act(async () => {
      fireSessionEvent('session:session-abc', makeIdleSessionState());
    });

    expect(result.current.pendingQuestion).toBeNull();
  });

  it('onQuestionResolved moves pendingQuestion to resolvedQuestions optimistically', async () => {
    mockRequest.mockResolvedValue(makeWaitingSessionState('tool-001'));

    const { result } = renderHook(() => useSessionQuestionState('session-abc'));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.pendingQuestion).not.toBeNull();

    await act(async () => {
      result.current.onQuestionResolved('submitted', [
        { questionIndex: 0, selectedLabels: ['Option A'], customText: undefined },
      ]);
    });

    expect(result.current.pendingQuestion).toBeNull();
    expect(result.current.resolvedQuestions.size).toBe(1);
    const resolved = result.current.resolvedQuestions.get('tool-001');
    expect(resolved?.state).toBe('submitted');
    expect(resolved?.question.toolUseId).toBe('tool-001');
  });

  it('onQuestionResolved is a no-op when no pendingQuestion exists', () => {
    const { result } = renderHook(() => useSessionQuestionState('session-abc'));

    act(() => {
      result.current.onQuestionResolved('cancelled', []);
    });

    expect(result.current.resolvedQuestions.size).toBe(0);
  });

  it('preserves resolvedQuestions when a state event arrives with null sessionInfo (optimistic update not erased)', async () => {
    mockRequest.mockResolvedValue(makeWaitingSessionState('tool-001'));

    const { result } = renderHook(() => useSessionQuestionState('session-abc'));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      result.current.onQuestionResolved('submitted', [
        { questionIndex: 0, selectedLabels: ['Yes'], customText: undefined },
      ]);
    });

    expect(result.current.resolvedQuestions.size).toBe(1);

    act(() => {
      fireSessionEvent('session:session-abc', makeIdleSessionState());
    });

    await waitFor(() => {
      expect(result.current.pendingQuestion).toBeNull();
    });

    expect(result.current.resolvedQuestions.size).toBe(1);
    expect(result.current.resolvedQuestions.get('tool-001')?.state).toBe('submitted');
  });
});

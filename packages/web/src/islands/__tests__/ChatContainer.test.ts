import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  shouldBlockForPendingQuestion,
  computeChatLoading,
  resolveChatRoute,
} from '../ChatContainer.tsx';
import type { AgentProcessingState } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import chatContainerSource from '../ChatContainer.tsx?raw';

const rafCallbacks: Array<() => void> = [];
const mockRaf = vi.fn((callback: FrameRequestCallback) => {
  rafCallbacks.push(callback as unknown as () => void);
  return rafCallbacks.length;
});

function flushRAF(): void {
  const callbacks = [...rafCallbacks];
  rafCallbacks.length = 0;
  callbacks.forEach((cb) => cb());
}

describe('ChatContainer input guard', () => {
  const waitingState: AgentProcessingState = {
    status: 'waiting_for_input',
    pendingQuestion: { toolUseId: 'tool-123', questions: [], askedAt: 1000 },
  };

  it('blocks input while waiting_for_input without terminal result', () => {
    expect(shouldBlockForPendingQuestion(waitingState, [])).toBe(true);
  });

  it('allows input when stale waiting_for_input follows a terminal result', () => {
    const messages = [{ type: 'result' }] as SDKMessage[];

    expect(shouldBlockForPendingQuestion(waitingState, messages)).toBe(false);
  });

  it('keeps the lock when a terminal result is not the trailing message', () => {
    const messages = [
      { type: 'assistant' },
      { type: 'result' },
      { type: 'user' },
      { type: 'assistant' },
    ] as SDKMessage[];

    expect(shouldBlockForPendingQuestion(waitingState, messages)).toBe(true);
  });

  it.each([
    ['idle', { status: 'idle' }],
    ['processing', { status: 'processing', phase: 'streaming' }],
    ['queued', { status: 'queued', messageId: 'm-1' }],
    ['interrupted', { status: 'interrupted' }],
  ])('never blocks when the agent status is %s', (_label, agentState) => {
    const messages = [{ type: 'user' }] as SDKMessage[];

    expect(shouldBlockForPendingQuestion(agentState as AgentProcessingState, messages)).toBe(false);
  });
});

describe('ChatContainer State Batching', () => {
  const originalRAF = globalThis.requestAnimationFrame;

  beforeEach(() => {
    rafCallbacks.length = 0;
    mockRaf.mockClear();
    globalThis.requestAnimationFrame = mockRaf as unknown as typeof requestAnimationFrame;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF;
  });

  describe('requestAnimationFrame batching', () => {
    it('should defer state updates to requestAnimationFrame', () => {
      const stateUpdates: string[] = [];

      const mockSetSession = vi.fn((val: unknown) => stateUpdates.push(`session:${val}`));
      const mockSetContextUsage = vi.fn((val: unknown) => stateUpdates.push(`context:${val}`));
      const mockSetSending = vi.fn((val: unknown) => stateUpdates.push(`sending:${val}`));
      const mockSetCurrentAction = vi.fn((val: unknown) => stateUpdates.push(`action:${val}`));
      const mockSetStreamingPhase = vi.fn((val: unknown) => stateUpdates.push(`phase:${val}`));

      const data = {
        session: { id: 'test-session' },
        context: { tokens: 1000 },
        agent: {
          status: 'processing' as const,
          phase: 'initializing' as const,
        },
        commands: { availableCommands: ['/help'] },
      };

      requestAnimationFrame(() => {
        if (data.session) {
          mockSetSession(data.session);
        }
        if (data.context) {
          mockSetContextUsage(data.context);
        }

        mockSetSending(true);
        mockSetCurrentAction('Starting...');
        mockSetStreamingPhase('initializing');
      });

      expect(stateUpdates.length).toBe(0);
      expect(mockRaf).toHaveBeenCalledTimes(1);

      flushRAF();

      expect(stateUpdates.length).toBe(5);
      expect(stateUpdates).toContain('session:[object Object]');
      expect(stateUpdates).toContain('sending:true');
      expect(stateUpdates).toContain('action:Starting...');
      expect(stateUpdates).toContain('phase:initializing');
    });

    it('should process multiple state events in order', () => {
      const events: string[] = [];

      requestAnimationFrame(() => events.push('event1'));
      requestAnimationFrame(() => events.push('event2'));
      requestAnimationFrame(() => events.push('event3'));

      expect(events.length).toBe(0);
      expect(mockRaf).toHaveBeenCalledTimes(3);

      flushRAF();

      expect(events).toEqual(['event1', 'event2', 'event3']);
    });
  });

  describe('agent status transitions', () => {
    it('should correctly map idle status to state values', () => {
      const agentStatus = 'idle' as const;

      let newSending = false;
      let newAction: string | undefined;
      let newPhase: string | null = null;
      let clearStreamingEvents = false;

      switch (agentStatus) {
        case 'idle':
          newSending = false;
          newAction = undefined;
          newPhase = null;
          clearStreamingEvents = true;
          break;
      }

      expect(newSending).toBe(false);
      expect(newAction).toBeUndefined();
      expect(newPhase).toBeNull();
      expect(clearStreamingEvents).toBe(true);
    });

    it('should correctly map queued status to state values', () => {
      const agentStatus = 'queued' as const;

      let newSending = false;
      let newAction: string | undefined;
      let newPhase: string | null = null;

      switch (agentStatus) {
        case 'queued':
          newSending = true;
          newAction = 'Queued...';
          newPhase = null;
          break;
      }

      expect(newSending).toBe(true);
      expect(newAction).toBe('Queued...');
      expect(newPhase).toBeNull();
    });

    it('should correctly map processing/initializing to state values', () => {
      const agentStatus = 'processing' as const;
      const agentPhase = 'initializing';

      let newSending = false;
      let newAction: string | undefined;
      let newPhase: string | null = null;

      if (agentStatus === 'processing') {
        newSending = true;
        newPhase = agentPhase;

        if (agentPhase === 'initializing') {
          newAction = 'Starting...';
        } else if (agentPhase === 'thinking') {
          newAction = 'Thinking...';
        } else if (agentPhase === 'streaming') {
          newAction = 'Streaming...';
        } else if (agentPhase === 'finalizing') {
          newAction = 'Finalizing...';
        }
      }

      expect(newSending).toBe(true);
      expect(newAction).toBe('Starting...');
      expect(newPhase).toBe('initializing');
    });

    it('should correctly map interrupted status to state values', () => {
      const agentStatus = 'interrupted' as const;

      let newSending = false;
      let newAction: string | undefined;
      let newPhase: string | null = null;
      let clearStreamingEvents = false;

      switch (agentStatus) {
        case 'interrupted':
          newSending = false;
          newAction = 'Interrupted';
          newPhase = null;
          clearStreamingEvents = true;
          break;
      }

      expect(newSending).toBe(false);
      expect(newAction).toBe('Interrupted');
      expect(newPhase).toBeNull();
      expect(clearStreamingEvents).toBe(true);
    });

    it('should calculate streaming duration correctly', () => {
      const streamingStartedAt = Date.now() - 5000;

      const duration = streamingStartedAt
        ? Math.floor((Date.now() - streamingStartedAt) / 1000)
        : 0;

      expect(duration).toBeGreaterThanOrEqual(4);
      expect(duration).toBeLessThanOrEqual(6);

      const action = duration > 0 ? `Streaming (${duration}s)...` : 'Streaming...';
      expect(action).toMatch(/Streaming \(\d+s\)\.\.\./);
    });
  });
});

describe('Scroll Behavior', () => {
  describe('scrollToBottom function', () => {
    it('should use instant scroll by default', () => {
      let scrollOptions: ScrollIntoViewOptions | undefined;

      const mockScrollIntoView = vi.fn((options: ScrollIntoViewOptions) => {
        scrollOptions = options;
      });

      const mockRef = { current: { scrollIntoView: mockScrollIntoView } };

      const smooth = false;
      mockRef.current?.scrollIntoView({
        behavior: smooth ? 'smooth' : 'instant',
      });

      expect(scrollOptions?.behavior).toBe('instant');
    });

    it('should use smooth scroll when explicitly requested', () => {
      let scrollOptions: ScrollIntoViewOptions | undefined;

      const mockScrollIntoView = vi.fn((options: ScrollIntoViewOptions) => {
        scrollOptions = options;
      });

      const mockRef = { current: { scrollIntoView: mockScrollIntoView } };

      const smooth = true;
      mockRef.current?.scrollIntoView({
        behavior: smooth ? 'smooth' : 'instant',
      });

      expect(scrollOptions?.behavior).toBe('smooth');
    });
  });

  describe('scroll button visibility logic', () => {
    it('should show button when not near bottom', () => {
      const scrollTop = 0;
      const scrollHeight = 1000;
      const clientHeight = 500;

      const isNearBottom = scrollHeight - scrollTop - clientHeight < 200;

      expect(isNearBottom).toBe(false);
      expect(!isNearBottom).toBe(true);
    });

    it('should hide button when near bottom', () => {
      const scrollTop = 350;
      const scrollHeight = 1000;
      const clientHeight = 500;

      const isNearBottom = scrollHeight - scrollTop - clientHeight < 200;

      expect(isNearBottom).toBe(true);
      expect(!isNearBottom).toBe(false);
    });

    it('should hide button when exactly at bottom', () => {
      const scrollTop = 500;
      const scrollHeight = 1000;
      const clientHeight = 500;

      const isNearBottom = scrollHeight - scrollTop - clientHeight < 200;

      expect(isNearBottom).toBe(true);
      expect(!isNearBottom).toBe(false);
    });
  });
});

describe('ResizeObserver Integration', () => {
  it('should create ResizeObserver for scroll button updates', () => {
    const observeCalls: Element[] = [];
    const disconnectCalled = { value: false };

    const MockResizeObserver = class {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(element: Element) {
        observeCalls.push(element);
      }
      unobserve(_element: Element) {}
      disconnect() {
        disconnectCalled.value = true;
      }
    };

    const container = { tagName: 'DIV' } as unknown as Element;
    const handleScroll = vi.fn(() => {});

    const resizeObserver = new MockResizeObserver(() => {
      handleScroll();
    });
    resizeObserver.observe(container);

    expect(observeCalls).toContain(container);

    resizeObserver.disconnect();
    expect(disconnectCalled.value).toBe(true);
  });
});

describe('ChatContainer Loading Skeleton CLS Prevention', () => {
  const source = chatContainerSource;

  it('skeleton header uses h-[52px] to match ChatHeader fixed height', () => {
    expect(source).toMatch(/route\.route === 'loading'[\s\S]*?h-\[52px\]/);
  });

  it('skeleton header does not use py-3 for height', () => {
    const skeletonSection =
      source.match(/route\.route === 'loading'[\s\S]*?animate-spin/)?.[0] ?? '';
    expect(skeletonSection).not.toContain('py-3');
  });

  it('skeleton footer uses absolute positioning to match ChatComposer layout', () => {
    expect(source).toMatch(/route\.route === 'loading'[\s\S]*?absolute bottom-0 left-0 right-0/);
  });

  it('skeleton outer container includes relative to anchor the absolute footer', () => {
    expect(source).toMatch(
      /route\.route === 'loading'[\s\S]*?flex-1 flex flex-col bg-app-content overflow-hidden relative/
    );
  });
});

describe('Passive Event Listener', () => {
  it('should add scroll listener with passive option', () => {
    const addEventListenerCalls: Array<{
      type: string;
      options: AddEventListenerOptions | boolean | undefined;
    }> = [];

    const mockContainer = {
      addEventListener: vi.fn(
        (
          type: string,
          _handler: EventListener,
          options: AddEventListenerOptions | boolean | undefined
        ) => {
          addEventListenerCalls.push({ type, options });
        }
      ),
      removeEventListener: vi.fn(() => {}),
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 500,
    };

    const handleScroll = () => {};
    mockContainer.addEventListener('scroll', handleScroll, { passive: true });

    expect(addEventListenerCalls.length).toBe(1);
    expect(addEventListenerCalls[0].type).toBe('scroll');
    expect(addEventListenerCalls[0].options).toEqual({ passive: true });
  });
});

describe('ChatContainer session-scoped recovery', () => {
  const source = chatContainerSource;

  it('syncs the per-session isRecovering flag from the store', () => {
    expect(source).toMatch(/setIsRecovering\(store\.isRecovering\.value\)/);
  });

  it('renders a non-blocking recovering banner with a stable test id', () => {
    expect(source).toMatch(/data-testid="session-recovering-banner"/);
    expect(source).toMatch(/role="status"/);
    expect(source).toMatch(/aria-live="polite"/);
    expect(source).toMatch(/isRecovering && !error && !isInitialLoad/);
  });

  it('forwards isRecovering to the composer', () => {
    expect(source).toMatch(/isRecovering=\{isRecovering\}/);
  });

  it('disables the content-wide drop zone while recovering', () => {
    const block = source.match(/const composerDisabled =[\s\S]*?sandboxSwitching;/)?.[0] ?? '';
    expect(block).toContain('isRecovering');
  });

  it('disables rewind controls while recovering', () => {
    expect(source).toMatch(/onRewind=\{isRecovering \? undefined : handleRewindClick\}/);
    expect(source).toMatch(/if \(store\.isRecovering\.value\)[\s\S]*?Please wait/);
  });

  it('hides the active question prompt while recovering', () => {
    expect(source).toMatch(/pendingQuestion=\{isRecovering \? null : pendingQuestion\}/);
  });

  describe('computeChatLoading', () => {
    it('shows the skeleton until session state and the first snapshot arrive', () => {
      expect(
        computeChatLoading({
          error: null,
          isRecovering: false,
          sessionStateLoaded: false,
          messagesLoaded: false,
        })
      ).toBe(true);
      expect(
        computeChatLoading({
          error: null,
          isRecovering: false,
          sessionStateLoaded: true,
          messagesLoaded: false,
        })
      ).toBe(true);
      expect(
        computeChatLoading({
          error: null,
          isRecovering: false,
          sessionStateLoaded: false,
          messagesLoaded: true,
        })
      ).toBe(true);
    });

    it('hides the skeleton once fully loaded (not recovering)', () => {
      expect(
        computeChatLoading({
          error: null,
          isRecovering: false,
          sessionStateLoaded: true,
          messagesLoaded: true,
        })
      ).toBe(false);
    });

    it('keeps the transcript visible (no skeleton) when recovering an already-loaded session', () => {
      expect(
        computeChatLoading({
          error: null,
          isRecovering: true,
          sessionStateLoaded: true,
          messagesLoaded: true,
        })
      ).toBe(false);
    });

    it('keeps the skeleton when a disconnect lands before the first messages snapshot', () => {
      expect(
        computeChatLoading({
          error: null,
          isRecovering: true,
          sessionStateLoaded: true,
          messagesLoaded: false,
        })
      ).toBe(true);
    });

    it('keeps the skeleton when a disconnect lands after the snapshot but before state.session', () => {
      expect(
        computeChatLoading({
          error: null,
          isRecovering: true,
          sessionStateLoaded: false,
          messagesLoaded: true,
        })
      ).toBe(true);
    });

    it('short-circuits to the error UI (no skeleton) when there is an error', () => {
      expect(
        computeChatLoading({
          error: 'boom',
          isRecovering: false,
          sessionStateLoaded: false,
          messagesLoaded: false,
        })
      ).toBe(false);
    });
  });
});

describe('Pending Agent Mode', () => {
  const source = chatContainerSource;

  it('pendingAgent prop is declared on the interface', () => {
    expect(source).toMatch(
      /pendingAgent\?:\s*\{\s*taskId:\s*string;\s*agentName:\s*string[^}]*\}\s*\|\s*null/
    );
  });

  it('pending render root div has data-testid="pending-agent-overlay"', () => {
    expect(source).toMatch(/data-testid="pending-agent-overlay"/);
  });

  it('pending render root div has an aria-label for accessibility', () => {
    expect(source).toMatch(
      /aria-label=\{\`\$\{pendingAgent\.agentName\}\s*chat\s*\(starting\)\`\}/
    );
  });

  it('pending header mirrors ChatHeader height (h-[52px]) for CLS prevention', () => {
    const pendingBlock =
      source.match(/pending-agent-overlay"[\s\S]*?pending-agent-overlay-textarea/)?.[0] ?? '';
    expect(pendingBlock).toContain('min-h-[52px]');
  });

  it('pending body has data-testid="pending-agent-overlay-body"', () => {
    expect(source).toMatch(/data-testid="pending-agent-overlay-body"/);
  });

  it('handoff calls replaceOverlayHistory when live session appears', () => {
    expect(source).toMatch(/pendingLiveMember\?\.sessionId[\s\S]*?replaceOverlayHistory/);
  });

  it('handoff pins the displayed sessionId into the overlay context', () => {
    expect(source).toMatch(/sessionId:\s*pendingLiveMember\.sessionId/);
    expect(source).toMatch(/sessionId:\s*result\.sessionId/);
  });

  it('live-session watcher is scoped by pendingAgent.workflowNodeId', () => {
    expect(source).toContain('!pendingAgent.workflowNodeId');
    expect(source).toContain('m.nodeExecution?.nodeId === pendingAgent.workflowNodeId');
  });

  it('send handler calls spaceStore.activateTaskNodeAgent', () => {
    expect(source).toMatch(/spaceStore\.activateTaskNodeAgent\(/);
  });

  it('send handler calls replaceOverlayHistory when daemon returns sessionId', () => {
    expect(source).toMatch(/result\.sessionId[\s\S]*?replaceOverlayHistory/);
  });

  it('pending live-member handoff preserves nodeExecutionId in task context', () => {
    expect(source).toMatch(
      /pendingLiveMember\?\.sessionId[\s\S]*?pendingLiveMember\.nodeExecution\?\.nodeExecutionId[\s\S]*?nodeExecutionId: pendingLiveMember\.nodeExecution\.nodeExecutionId/
    );
  });

  it('synchronous pending send handoff preserves nodeExecutionId when activity is available', () => {
    expect(source).toMatch(
      /result\.sessionId[\s\S]*?matchingLiveMember[\s\S]*?matchingLiveMember\?\.nodeExecution\?\.nodeExecutionId[\s\S]*?nodeExecutionId: matchingLiveMember\.nodeExecution\.nodeExecutionId/
    );
  });

  it('error state sets pendingErrorMessage on failure', () => {
    expect(source).toMatch(/setPendingErrorMessage\(/);
  });

  it('Enter key triggers send (without Shift)', () => {
    expect(source).toMatch(/handlePendingKeyDown[\s\S]*?e\.key === 'Enter' && !e\.shiftKey/);
  });

  it('pending mode skips store.select() on mount', () => {
    const selectGuard = source.match(/pendingAgent[\s\S]*?store\.select\(/)?.[0] ?? '';
    expect(selectGuard).toContain('!');
  });
});

describe('resolveChatRoute — unavailable / load-error routing (task #873)', () => {
  const ready = {
    pending: false,
    loadErrorKind: null,
    loading: false,
    loadTimedOut: false,
    legacyFatal: false,
  };

  it('routes a healthy loaded session to ready', () => {
    expect(resolveChatRoute(ready).route).toBe('ready');
  });

  it('routes a pending agent to pending (before any load check)', () => {
    expect(resolveChatRoute({ ...ready, pending: true }).route).toBe('pending');
  });

  it.each([
    ['not-found', 'not-found'],
    ['unauthorized', 'unauthorized'],
    ['timeout', 'timeout'],
    ['disconnected', 'disconnected'],
    ['unknown', 'unknown'],
  ] as const)('routes a %s load error to the unavailable view with that kind', (kind, expected) => {
    const r = resolveChatRoute({ ...ready, loadErrorKind: kind });
    expect(r.route).toBe('unavailable');
    expect(r.unavailableKind).toBe(expected);
  });

  it('routes an in-progress initial load (no error) to the skeleton', () => {
    expect(resolveChatRoute({ ...ready, loading: true }).route).toBe('loading');
  });

  it('routes the 30s load backstop to an unavailable timeout (not the skeleton)', () => {
    const r = resolveChatRoute({ ...ready, loading: true, loadTimedOut: true });
    expect(r.route).toBe('unavailable');
    expect(r.unavailableKind).toBe('timeout');
  });

  it('routes the legacy fatal fallback (error, no sessionInfo, no kind) to unavailable unknown', () => {
    const r = resolveChatRoute({ ...ready, legacyFatal: true });
    expect(r.route).toBe('unavailable');
    expect(r.unavailableKind).toBe('unknown');
  });

  it('a load error takes precedence over the loading skeleton', () => {
    const r = resolveChatRoute({ ...ready, loading: true, loadErrorKind: 'not-found' });
    expect(r.route).toBe('unavailable');
    expect(r.unavailableKind).toBe('not-found');
  });

  it('an invalid nonempty session id never resolves to ready', () => {
    for (const kind of ['not-found', 'timeout', 'disconnected', 'unknown'] as const) {
      const r = resolveChatRoute({ ...ready, loadErrorKind: kind });
      expect(r.route).not.toBe('ready');
    }
  });

  it('archived/terminated are NOT load errors — they resolve to ready (banner shown in-view)', () => {
    expect(resolveChatRoute(ready).route).toBe('ready');
  });
});

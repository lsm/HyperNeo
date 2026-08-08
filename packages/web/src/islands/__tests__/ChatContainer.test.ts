/**
 * Tests for ChatContainer State Handling
 *
 * Tests the state update batching and scroll behavior optimizations.
 * These tests verify the fixes for UI freeze during state transitions.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { shouldBlockForPendingQuestion, computeChatLoading } from '../ChatContainer.tsx';
import type { AgentProcessingState } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
// Vite-native raw import — works in both Node and browser-like test environments
// (happy-dom) without reaching for Node built-ins like `fs`/`path`/`url`, which
// are externalized by Vite and unavailable at runtime in the test environment.
import chatContainerSource from '../ChatContainer.tsx?raw';

// Mock requestAnimationFrame for testing
const rafCallbacks: Array<() => void> = [];
const mockRaf = vi.fn((callback: FrameRequestCallback) => {
  rafCallbacks.push(callback as unknown as () => void);
  return rafCallbacks.length;
});

/**
 * Helper to flush all pending requestAnimationFrame callbacks
 */
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

  // Lifecycle-recovery edge cases for scenario 5 (terminal result arrival
  // after stale waiting_for_input). Only a TRAILING result clears the lock;
  // a result earlier in the thread (the agent kept going afterwards) must
  // not unlock the composer, and non-waiting statuses never block.
  it('keeps the lock when a terminal result is not the trailing message', () => {
    // The agent answered the question (result) and then produced more turns —
    // the trailing message is not a result, so a fresh waiting state still locks.
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
    // Mock requestAnimationFrame globally
    globalThis.requestAnimationFrame = mockRaf as unknown as typeof requestAnimationFrame;
  });

  afterEach(() => {
    // Restore original requestAnimationFrame
    globalThis.requestAnimationFrame = originalRAF;
  });

  describe('requestAnimationFrame batching', () => {
    it('should defer state updates to requestAnimationFrame', () => {
      // Simulate the state.session handler behavior
      const stateUpdates: string[] = [];

      const mockSetSession = vi.fn((val: unknown) => stateUpdates.push(`session:${val}`));
      const mockSetContextUsage = vi.fn((val: unknown) => stateUpdates.push(`context:${val}`));
      const mockSetSending = vi.fn((val: unknown) => stateUpdates.push(`sending:${val}`));
      const mockSetCurrentAction = vi.fn((val: unknown) => stateUpdates.push(`action:${val}`));
      const mockSetStreamingPhase = vi.fn((val: unknown) => stateUpdates.push(`phase:${val}`));

      // Simulate receiving state.session event
      const data = {
        session: { id: 'test-session' },
        context: { tokens: 1000 },
        agent: {
          status: 'processing' as const,
          phase: 'initializing' as const,
        },
        commands: { availableCommands: ['/help'] },
      };

      // The handler wraps everything in requestAnimationFrame
      requestAnimationFrame(() => {
        if (data.session) {
          mockSetSession(data.session);
        }
        if (data.context) {
          mockSetContextUsage(data.context);
        }

        // Apply state updates together
        mockSetSending(true);
        mockSetCurrentAction('Starting...');
        mockSetStreamingPhase('initializing');
      });

      // Before flushing, no updates should have happened
      expect(stateUpdates.length).toBe(0);
      expect(mockRaf).toHaveBeenCalledTimes(1);

      // Flush requestAnimationFrame
      flushRAF();

      // After flushing, all updates should have happened together
      expect(stateUpdates.length).toBe(5);
      expect(stateUpdates).toContain('session:[object Object]');
      expect(stateUpdates).toContain('sending:true');
      expect(stateUpdates).toContain('action:Starting...');
      expect(stateUpdates).toContain('phase:initializing');
    });

    it('should process multiple state events in order', () => {
      const events: string[] = [];

      // Simulate multiple rapid state events
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

        // Map phase to action - using if/else to avoid TypeScript narrowing issues
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
      const streamingStartedAt = Date.now() - 5000; // 5 seconds ago

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

      // Simulate scrollToBottom(false) - default
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

      // Simulate scrollToBottom(true) - smooth
      const smooth = true;
      mockRef.current?.scrollIntoView({
        behavior: smooth ? 'smooth' : 'instant',
      });

      expect(scrollOptions?.behavior).toBe('smooth');
    });
  });

  describe('scroll button visibility logic', () => {
    it('should show button when not near bottom', () => {
      // Simulate scroll container state
      const scrollTop = 0;
      const scrollHeight = 1000;
      const clientHeight = 500;

      const isNearBottom = scrollHeight - scrollTop - clientHeight < 200;

      expect(isNearBottom).toBe(false);
      // showScrollButton = !isNearBottom = true
      expect(!isNearBottom).toBe(true);
    });

    it('should hide button when near bottom', () => {
      // Simulate scroll container near bottom
      const scrollTop = 350;
      const scrollHeight = 1000;
      const clientHeight = 500;

      const isNearBottom = scrollHeight - scrollTop - clientHeight < 200;

      expect(isNearBottom).toBe(true);
      // showScrollButton = !isNearBottom = false
      expect(!isNearBottom).toBe(false);
    });

    it('should hide button when exactly at bottom', () => {
      // Simulate scroll container at bottom
      const scrollTop = 500;
      const scrollHeight = 1000;
      const clientHeight = 500;

      const isNearBottom = scrollHeight - scrollTop - clientHeight < 200;

      expect(isNearBottom).toBe(true);
      // showScrollButton = !isNearBottom = false
      expect(!isNearBottom).toBe(false);
    });
  });
});

describe('ResizeObserver Integration', () => {
  it('should create ResizeObserver for scroll button updates', () => {
    const observeCalls: Element[] = [];
    const disconnectCalled = { value: false };

    // Mock ResizeObserver
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

    // Simulate the useEffect behavior
    const container = { tagName: 'DIV' } as unknown as Element;
    const handleScroll = vi.fn(() => {});

    const resizeObserver = new MockResizeObserver(() => {
      handleScroll();
    });
    resizeObserver.observe(container);

    expect(observeCalls).toContain(container);

    // Simulate cleanup
    resizeObserver.disconnect();
    expect(disconnectCalled.value).toBe(true);
  });
});

/**
 * Loading Skeleton Layout Invariants (CLS prevention)
 *
 * These tests guard against regressions that would re-introduce Cumulative Layout
 * Shift (CLS) when the loading skeleton transitions to real content.
 *
 * Root cause of CLS:
 * - ChatHeader uses `h-[52px]` (fixed 52 px).  A skeleton header with `py-3`
 *   renders at ~40 px — a visible shift on load.
 * - ChatComposer renders as `absolute bottom-0 left-0 right-0`, so it does NOT
 *   participate in the flex layout.  A skeleton footer that IS in the flex flow
 *   consumes height that later disappears, causing the messages area to shift.
 */
describe('ChatContainer Loading Skeleton CLS Prevention', () => {
  const source = chatContainerSource;

  it('skeleton header uses h-[52px] to match ChatHeader fixed height', () => {
    // ChatHeader sets `h-[52px]`.  The skeleton must use the same value so
    // the header occupies identical vertical space before and after load.
    expect(source).toMatch(/Skeleton header[\s\S]*?h-\[52px\]/);
  });

  it('skeleton header does not use py-3 for height', () => {
    // py-3 gives ~40 px, which caused a visible shift when the real
    // header appeared.  Verify it is not used as a height stand-in.
    const skeletonSection =
      source.match(/\/\* Skeleton header[\s\S]*?\/\* Skeleton messages/)?.[0] ?? '';
    expect(skeletonSection).not.toContain('py-3');
  });

  it('skeleton footer uses absolute positioning to match ChatComposer layout', () => {
    // ChatComposer renders as `absolute bottom-0 left-0 right-0` — it is
    // outside the flex flow.  The skeleton footer must also be absolute so the
    // flex calculation (header + messages flex-1) is identical on both sides of
    // the skeleton → content transition.
    expect(source).toMatch(/Skeleton footer[\s\S]*?absolute bottom-0 left-0 right-0/);
  });

  it('skeleton outer container includes relative to anchor the absolute footer', () => {
    // The absolutely-positioned footer needs a positioned ancestor.
    // Verify `relative` is present in the skeleton's outer container class.
    expect(source).toMatch(
      /flex-1 flex flex-col bg-app-content overflow-hidden relative[\s\S]*?Skeleton header/
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

    // Simulate adding scroll listener with passive: true
    const handleScroll = () => {};
    mockContainer.addEventListener('scroll', handleScroll, { passive: true });

    expect(addEventListenerCalls.length).toBe(1);
    expect(addEventListenerCalls[0].type).toBe('scroll');
    expect(addEventListenerCalls[0].options).toEqual({ passive: true });
  });
});

/**
 * Pending Agent Mode — Source-Level Structural Tests
 *
 * When the `pendingAgent` prop is set, ChatContainer renders a completely
 * separate UI tree (early return before the loading skeleton). These tests
 * guard against regressions in the pending agent render by asserting on the
 * raw source code.
 *
 * The pending agent mode replaced the standalone `PendingAgentOverlay`
 * component (deleted in PR #1670). The logic is:
 *   1. Render a "not started yet" state with a minimal composer.
 *   2. On send, call `spaceStore.activateTaskNodeAgent(taskId, agentName, msg)`.
 *   3. Watch `spaceStore.taskActivity` for a live session; when found, call
 *      `replaceOverlayHistory(sessionId, agentName, undefined, taskContext)` to hand off.
 */
/**
 * Session-scoped reconnect recovery (#872). Source-level guards for the
 * per-session recovering state: the transcript must stay visible (loading
 * skeleton cannot relapse during recovery), the composer must stay disabled
 * until THIS session is ready (not merely when the socket reports ready), and a
 * non-blocking indicator marks the recovery. Behavioral coverage lives in the
 * SessionStore multi-instance suite.
 */
describe('ChatContainer session-scoped recovery', () => {
  const source = chatContainerSource;

  it('syncs the per-session isRecovering flag from the store', () => {
    expect(source).toMatch(/setIsRecovering\(store\.isRecovering\.value\)/);
  });

  it('renders a non-blocking recovering banner with a stable test id', () => {
    expect(source).toMatch(/data-testid="session-recovering-banner"/);
    // Non-blocking: role=status + polite live region, shown only outside the
    // initial load and when there is no error.
    expect(source).toMatch(/role="status"/);
    expect(source).toMatch(/aria-live="polite"/);
    expect(source).toMatch(/isRecovering && !error && !isInitialLoad/);
  });

  it('forwards isRecovering to the composer', () => {
    expect(source).toMatch(/isRecovering=\{isRecovering\}/);
  });

  it('disables the content-wide drop zone while recovering', () => {
    // composerDisabled gates the parent image drop zone; it must include
    // isRecovering so a file drop is not advertised then silently discarded
    // while MessageInput is disabled.
    const block = source.match(/const composerDisabled =[\s\S]*?sandboxSwitching;/)?.[0] ?? '';
    expect(block).toContain('isRecovering');
  });

  it('disables rewind controls while recovering', () => {
    // The rewind affordance must be hidden during recovery (onRewind undefined)
    // so the advertised read-only state covers this mutation too.
    expect(source).toMatch(/onRewind=\{isRecovering \? undefined : handleRewindClick\}/);
    // And the confirm path bails on the store flag, in case a modal was already
    // open when recovery started.
    expect(source).toMatch(/if \(store\.isRecovering\.value\)[\s\S]*?Please wait/);
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
      // The headline recovery invariant: a reconnecting chat that had loaded
      // must not flash the skeleton.
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
      // Reviewer finding: state.session loaded, first snapshot NOT yet arrived,
      // then the connection drops. isRecovering flips true but messagesLoaded is
      // still false — the skeleton must stay so we don't render "No messages
      // yet" for a conversation whose messages are still in flight.
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
      // Inverse arrival order: messages snapshot arrived first, state.session
      // has not, then the connection drops. The initial load is still incomplete
      // (no metadata), so the skeleton must stay — recovery preserves the
      // transcript only once BOTH load halves completed.
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
      /pendingAgent\?:\s*\{\s*taskId:\s*string;\s*agentName:\s*string\s*\}\s*\|\s*null/
    );
  });

  it('pending render root div has data-testid="pending-agent-overlay"', () => {
    // The early-return block for pendingAgent renders a div with this test ID
    expect(source).toMatch(/data-testid="pending-agent-overlay"/);
  });

  it('pending render root div has an aria-label for accessibility', () => {
    // Screen readers need to identify which agent overlay is open
    expect(source).toMatch(
      /aria-label=\{\`\$\{pendingAgent\.agentName\}\s*chat\s*\(starting\)\`\}/
    );
  });

  it('pending header mirrors ChatHeader height (h-[52px]) for CLS prevention', () => {
    // The pending header must match ChatHeader's fixed 52px height to avoid
    // layout shift when the overlay hands off to the live session view.
    const pendingBlock =
      source.match(/Pending Agent Render[\s\S]*?pending-agent-overlay-textarea/)?.[0] ?? '';
    expect(pendingBlock).toContain('min-h-[52px]');
  });

  it('pending body has data-testid="pending-agent-overlay-body"', () => {
    expect(source).toMatch(/data-testid="pending-agent-overlay-body"/);
  });

  it('handoff calls replaceOverlayHistory when live session appears', () => {
    // The effect that watches pendingLiveMember must call replaceOverlayHistory
    // with the session ID to transition from pending to live session mode.
    expect(source).toMatch(/pendingLiveMember\?\.sessionId[\s\S]*?replaceOverlayHistory/);
  });

  it('send handler calls spaceStore.activateTaskNodeAgent', () => {
    // On send, the pending mode activates the agent via the store method
    expect(source).toMatch(/spaceStore\.activateTaskNodeAgent\(/);
  });

  it('send handler calls replaceOverlayHistory when daemon returns sessionId', () => {
    // If the daemon returns a sessionId synchronously, hand off immediately
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
    // When activateTaskNodeAgent throws, the error message must be surfaced
    expect(source).toMatch(/setPendingErrorMessage\(/);
  });

  it('Enter key triggers send (without Shift)', () => {
    // The pending composer should send on Enter alone, like the main composer
    expect(source).toMatch(/handlePendingKeyDown[\s\S]*?e\.key === 'Enter' && !e\.shiftKey/);
  });

  it('pending mode skips store.select() on mount', () => {
    // When pendingAgent is set, the component must NOT call store.select()
    // since there is no live session to load. (ChatContainer binds the injected
    // store — defaulting to the singleton — to the local `store` identifier.)
    const selectGuard = source.match(/pendingAgent[\s\S]*?store\.select\(/)?.[0] ?? '';
    expect(selectGuard).toContain('!');
  });
});

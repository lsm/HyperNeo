// @ts-nocheck
/**
 * Tests for useAutoScroll Hook
 *
 * Tests auto-scroll behavior, scroll button visibility,
 * and automatic scrolling when new content arrives.
 */

import { renderHook, act } from '@testing-library/preact';
import type { RefObject } from 'preact';

// Import after mocking (no external dependencies to mock)
import { useAutoScroll } from '../useAutoScroll.ts';

// Helper to create mock refs
function createMockRefs() {
  const scrollIntoViewMock = vi.fn(function (this: HTMLDivElement, options?: ScrollToOptions) {
    if (typeof options?.top === 'number') {
      this.scrollTop = options.top;
    }
  });
  const addEventListenerMock = vi.fn(() => {});
  const removeEventListenerMock = vi.fn(() => {});
  const scrollToMock = scrollIntoViewMock;

  const contentWrapper = {} as HTMLDivElement;
  const containerRef = {
    current: {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 500,
      scrollTo: scrollToMock,
      addEventListener: addEventListenerMock,
      removeEventListener: removeEventListenerMock,
    } as unknown as HTMLDivElement,
  } as RefObject<HTMLDivElement>;

  const endRef = {
    current: {
      parentElement: contentWrapper,
      scrollIntoView: scrollIntoViewMock,
    } as unknown as HTMLDivElement,
  } as RefObject<HTMLDivElement>;

  return {
    containerRef,
    endRef,
    scrollIntoViewMock,
    scrollToMock,
    addEventListenerMock,
    removeEventListenerMock,
  };
}

// Store ResizeObserver instances for testing
let resizeObserverInstances: MockResizeObserver[] = [];

// Mock ResizeObserver
class MockResizeObserver {
  callback: ResizeObserverCallback;
  observedTargets: Element[] = [];

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObserverInstances.push(this);
  }
  observe(target: Element) {
    this.observedTargets.push(target);
  }
  unobserve() {}
  disconnect() {}
  // Helper to trigger resize callback
  triggerResize() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

// Set up global mock
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

describe('useAutoScroll', () => {
  beforeEach(() => {
    // Reset ResizeObserver instances
    resizeObserverInstances = [];
  });

  describe('initialization', () => {
    it('should initialize with default values', () => {
      const { containerRef, endRef } = createMockRefs();

      const { result } = renderHook(() =>
        useAutoScroll({
          containerRef,
          endRef,
          enabled: true,
          messageCount: 0,
        })
      );

      expect(typeof result.current.showScrollButton).toBe('boolean');
      expect(typeof result.current.scrollToBottom).toBe('function');
      expect(typeof result.current.isNearBottom).toBe('boolean');
    });

    it('should return stable function references', () => {
      const { containerRef, endRef } = createMockRefs();

      const { result, rerender } = renderHook(() =>
        useAutoScroll({
          containerRef,
          endRef,
          enabled: true,
          messageCount: 5,
        })
      );

      const firstScrollToBottom = result.current.scrollToBottom;

      rerender();

      expect(result.current.scrollToBottom).toBe(firstScrollToBottom);
    });
  });

  describe('scrollToBottom', () => {
    it('should scroll the container to its scrollHeight with instant behavior by default', () => {
      const { containerRef, endRef, scrollToMock } = createMockRefs();

      const { result } = renderHook(() =>
        useAutoScroll({
          containerRef,
          endRef,
          enabled: true,
          messageCount: 0,
        })
      );

      act(() => {
        result.current.scrollToBottom();
      });

      // Instant path uses direct property assignment, not scrollTo().
      expect(scrollToMock).not.toHaveBeenCalled();
      expect(containerRef.current!.scrollTop).toBe(1000);
    });

    it('should scroll the container to its scrollHeight with smooth behavior when specified', () => {
      const { containerRef, endRef, scrollToMock } = createMockRefs();

      const { result } = renderHook(() =>
        useAutoScroll({
          containerRef,
          endRef,
          enabled: true,
          messageCount: 0,
        })
      );

      act(() => {
        result.current.scrollToBottom(true);
      });

      expect(scrollToMock).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });
      expect(containerRef.current!.scrollTop).toBe(1000);
    });

    it('should handle null endRef gracefully', () => {
      const { containerRef } = createMockRefs();
      const nullEndRef = { current: null } as RefObject<HTMLDivElement>;

      const { result } = renderHook(() =>
        useAutoScroll({
          containerRef,
          endRef: nullEndRef,
          enabled: true,
          messageCount: 0,
        })
      );

      // Should not throw
      act(() => {
        result.current.scrollToBottom();
      });
    });
  });

  describe('auto-scroll behavior', () => {
    it('should observe the container and content wrapper for resize-driven anchoring', () => {
      const { containerRef, endRef } = createMockRefs();

      renderHook(() =>
        useAutoScroll({
          containerRef,
          endRef,
          enabled: true,
          messageCount: 0,
        })
      );

      expect(resizeObserverInstances[0]?.observedTargets).toEqual([
        containerRef.current,
        endRef.current!.parentElement,
      ]);
    });

    it('should scroll on initial load when messages arrive', () => {
      vi.useFakeTimers();
      const { containerRef, endRef } = createMockRefs();

      // Start with isInitialLoad=true and 0 messages
      const { rerender } = renderHook(
        ({ messageCount, isInitialLoad }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: true,
            messageCount,
            isInitialLoad,
          }),
        {
          initialProps: { messageCount: 0, isInitialLoad: true },
        }
      );

      // Rerender with messages arriving
      rerender({ messageCount: 5, isInitialLoad: true });
      expect(containerRef.current!.scrollTop).toBe(1000);

      // Layout grows after first scroll; deferred rAF scroll should re-pin.
      containerRef.current!.scrollHeight = 1200;
      act(() => {
        vi.advanceTimersByTime(16);
      });
      expect(containerRef.current!.scrollTop).toBe(1200);
      vi.useRealTimers();
    });

    it('should NOT force-scroll on initial load when enabled=false (deep-link case)', () => {
      // When the caller asks us to focus a specific row (e.g. via the
      // `useScrollToMessage` hook), it sets `enabled: false` so the
      // initial-load forced scroll-to-bottom does not race with — and
      // override — the deep-link `scrollIntoView`.
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount, isInitialLoad, enabled }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled,
            messageCount,
            isInitialLoad,
          }),
        {
          initialProps: { messageCount: 0, isInitialLoad: true, enabled: false },
        }
      );

      // Messages arrive while disabled — should NOT force scroll.
      rerender({ messageCount: 5, isInitialLoad: true, enabled: false });
      expect(containerRef.current!.scrollTop).toBe(0);
    });

    it('should cancel deferred re-pin when enabled flips false before next frame', () => {
      vi.useFakeTimers();
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount, enabled }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled,
            messageCount,
            isInitialLoad: false,
          }),
        {
          initialProps: { messageCount: 0, enabled: true },
        }
      );

      rerender({ messageCount: 5, enabled: true });
      expect(containerRef.current!.scrollTop).toBe(1000);

      containerRef.current!.scrollHeight = 1200;
      rerender({ messageCount: 5, enabled: false });
      act(() => {
        vi.advanceTimersByTime(16);
      });

      expect(containerRef.current!.scrollTop).toBe(1000);
      vi.useRealTimers();
    });

    it('should scroll when new messages arrive and enabled', () => {
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: true,
            messageCount,
            isInitialLoad: false,
          }),
        {
          initialProps: { messageCount: 5 },
        }
      );

      // Add new message
      rerender({ messageCount: 6 });

      expect(containerRef.current!.scrollTop).toBe(1000);
    });

    it('should not scroll when new messages arrive but disabled', () => {
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: false,
            messageCount,
            isInitialLoad: false,
          }),
        {
          initialProps: { messageCount: 5 },
        }
      );

      // Initial mount-scroll already fired (messageCount > 0 on first render).
      const baselineScroll = containerRef.current!.scrollTop;

      // Add new message
      rerender({ messageCount: 6 });

      // scrollTop should not have changed (no auto-scroll when disabled).
      expect(containerRef.current!.scrollTop).toBe(baselineScroll);
    });

    it('should cancel deferred re-pin when loadingOlder flips true before next frame', () => {
      vi.useFakeTimers();
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount, loadingOlder }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: true,
            messageCount,
            isInitialLoad: false,
            loadingOlder,
          }),
        {
          initialProps: { messageCount: 0, loadingOlder: false },
        }
      );

      rerender({ messageCount: 5, loadingOlder: false });
      expect(containerRef.current!.scrollTop).toBe(1000);

      containerRef.current!.scrollHeight = 1200;
      rerender({ messageCount: 5, loadingOlder: true });
      act(() => {
        vi.advanceTimersByTime(16);
      });

      expect(containerRef.current!.scrollTop).toBe(1000);
      vi.useRealTimers();
    });

    it('should not scroll when loading older messages', () => {
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount, loadingOlder }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: true,
            messageCount,
            isInitialLoad: false,
            loadingOlder,
          }),
        {
          initialProps: { messageCount: 5, loadingOlder: true },
        }
      );

      // loadingOlder=true suppresses auto-scroll, including mount scroll.
      // scrollTop stays at 0 because the mount-scroll is blocked.
      expect(containerRef.current!.scrollTop).toBe(0);

      // Add messages while loading older — still no scroll.
      rerender({ messageCount: 10, loadingOlder: true });
      expect(containerRef.current!.scrollTop).toBe(0);
    });

    it('should not auto-scroll when loadingOlder transitions from true to false', () => {
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount, loadingOlder }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: true,
            messageCount,
            isInitialLoad: false,
            loadingOlder,
          }),
        {
          initialProps: { messageCount: 50, loadingOlder: false },
        }
      );

      // Initial mount-scroll already fired.
      const baselineScroll = containerRef.current!.scrollTop;

      // Start loading older — message count increases as hidden messages are revealed
      rerender({ messageCount: 55, loadingOlder: true });

      // Finish loading older — message count stays at 55, loadingOlder flips to false.
      // This should NOT trigger auto-scroll because the count increase came from
      // revealing older messages, not from genuinely new messages.
      rerender({ messageCount: 55, loadingOlder: false });
      expect(containerRef.current!.scrollTop).toBe(baselineScroll);
    });

    it('should not auto-scroll across a load-older transition where messageCount also increases', () => {
      // Reproduces the production load-older flow more faithfully: the
      // daemon batches `setMessages(M+older)` and `setLoadingOlder(false)`
      // into a single render after the await resolves. With auto-scroll
      // running as a useLayoutEffect, an ordinary useEffect-based
      // `prevMessageCountRef` update would race and let the auto-scroll
      // effect see a stale `prev`, scrolling the user to the bottom and
      // clobbering ChatContainer's scroll-position restore. The
      // loadingOlder-tracker therefore also runs as a useLayoutEffect
      // declared first.
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount, loadingOlder }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: true,
            messageCount,
            isInitialLoad: false,
            loadingOlder,
          }),
        {
          initialProps: { messageCount: 200, loadingOlder: false },
        }
      );

      // Initial mount-scroll already fired.
      const baselineScroll = containerRef.current!.scrollTop;

      // User clicks "Load more" — loadingOlder flips on first.
      rerender({ messageCount: 200, loadingOlder: true });

      // Older messages prepended AND loadingOlder cleared in the same
      // render (post-await batching): messageCount jumps from 200 → 250.
      rerender({ messageCount: 250, loadingOlder: false });
      expect(containerRef.current!.scrollTop).toBe(baselineScroll);
    });

    it('should scroll on first non-empty messageCount even when isInitialLoad is already false', () => {
      // Reproduces the navigate-back-to-cached-session bug: preact
      // batches the signal-driven `setIsInitialLoad(false)` and
      // `setMessages(M)` updates so by the time messageCount first
      // becomes non-zero, isInitialLoad has already flipped to false.
      // The hook must still scroll on this first non-empty render —
      // otherwise the user lands somewhere mid-conversation instead of
      // at the latest messages.
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount, isInitialLoad }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: true,
            messageCount,
            isInitialLoad,
          }),
        {
          // Mount with messages=0 AND isInitialLoad already false —
          // this is the cached-session navigation case: the store's
          // signals have already flipped the parent's `isInitialLoad`
          // state by the time this hook first runs.
          initialProps: { messageCount: 0, isInitialLoad: false },
        }
      );

      // Messages arrive in the next render. Even though isInitialLoad
      // stays false, the hook should scroll because this is the first
      // non-empty messageCount on this mount.
      rerender({ messageCount: 12, isInitialLoad: false });
      expect(containerRef.current!.scrollTop).toBe(1000);
    });

    it('should scroll on first non-empty messageCount even when enabled is false', () => {
      // Initial-mount scroll is a "navigation/visit" scroll, not an
      // auto-scroll-on-new-content. The user's autoScroll preference
      // only governs SUBSEQUENT scrolling, mirroring the existing
      // initial-load behavior.
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: false,
            messageCount,
            isInitialLoad: false,
          }),
        {
          initialProps: { messageCount: 0 },
        }
      );

      rerender({ messageCount: 8 });
      expect(containerRef.current!.scrollTop).toBe(1000);

      // Subsequent new content with enabled=false must NOT scroll.
      rerender({ messageCount: 9 });
      expect(containerRef.current!.scrollTop).toBe(1000);
    });

    it('should only scroll once on mount, even after multiple message updates', () => {
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: false,
            messageCount,
            isInitialLoad: false,
          }),
        {
          initialProps: { messageCount: 0 },
        }
      );

      rerender({ messageCount: 5 });
      expect(containerRef.current!.scrollTop).toBe(1000);

      // Re-renders with same messageCount: should not re-scroll.
      rerender({ messageCount: 5 });
      expect(containerRef.current!.scrollTop).toBe(1000);
    });

    it('should scroll to bottom on task switch without remount (messageCount N → 0 → M)', () => {
      // Reproduces the SpaceTaskUnifiedThread task-switch scenario:
      // Component re-renders in place (no key change), so hasScrolledOnMountRef
      // stays true from the previous task. When rows are cleared (messageCount→0)
      // and then repopulated from the new task (messageCount→M), the hook must
      // still scroll to the bottom via the hasNewContent path.
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount, isInitialLoad }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: true,
            messageCount,
            isInitialLoad,
          }),
        {
          // Task A: loaded with 10 messages, isInitialLoad=false (loaded)
          initialProps: { messageCount: 10, isInitialLoad: false },
        }
      );

      // Initial mount-scroll fires (messageCount > 0 on first render)
      expect(containerRef.current!.scrollTop).toBe(1000);

      // Task B: rows cleared, loading starts (isInitialLoad=true)
      rerender({ messageCount: 0, isInitialLoad: true });

      // Task B: snapshot arrives, loading done (isInitialLoad=false)
      rerender({ messageCount: 15, isInitialLoad: false });

      // Should have scrolled for the new task's content
      expect(containerRef.current!.scrollTop).toBe(1000);
    });

    it('should scroll to bottom on task switch when new task has fewer messages', () => {
      // Edge case: switching from a task with many messages to one with fewer.
      // The hasNewContent path checks messageCount > prevMessageCountRef,
      // but the 0 → M transition ensures hasNewContent is always true.
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount, isInitialLoad }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: true,
            messageCount,
            isInitialLoad,
          }),
        {
          // Task A has 50 messages
          initialProps: { messageCount: 50, isInitialLoad: false },
        }
      );

      expect(containerRef.current!.scrollTop).toBe(1000);

      // Task B: rows cleared, loading starts
      rerender({ messageCount: 0, isInitialLoad: true });

      // Task B: only 5 messages (fewer than task A's 50)
      rerender({ messageCount: 5, isInitialLoad: false });

      // Should still scroll even though new task has fewer messages
      expect(containerRef.current!.scrollTop).toBe(1000);
    });

    it('should scroll on repeated task switches (N → 0 → M → 0 → K)', () => {
      // Simulates switching between multiple tasks in sequence.
      // Each switch goes through: loaded → loading (0) → loaded (new messages).
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount, isInitialLoad }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: true,
            messageCount,
            isInitialLoad,
          }),
        {
          initialProps: { messageCount: 10, isInitialLoad: false },
        }
      );

      // Task A: initial load
      expect(containerRef.current!.scrollTop).toBe(1000);

      // Switch to task B: loading → loaded
      rerender({ messageCount: 0, isInitialLoad: true });
      rerender({ messageCount: 20, isInitialLoad: false });
      expect(containerRef.current!.scrollTop).toBe(1000);

      // Switch to task C: loading → loaded (fewer messages)
      rerender({ messageCount: 0, isInitialLoad: true });
      rerender({ messageCount: 3, isInitialLoad: false });
      expect(containerRef.current!.scrollTop).toBe(1000);
    });

    it('should scroll on new content after messageCount drops to 0', () => {
      vi.useFakeTimers();
      // When the message list is cleared (task switch, session navigation),
      // prevMessageCountRef resets so the next non-zero count is
      // seen as new content. This is the fix for SpaceTaskUnifiedThread,
      // which re-renders in place without a key change on task switch.
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount, enabled }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled,
            messageCount,
            isInitialLoad: false,
          }),
        {
          initialProps: { messageCount: 10, enabled: true },
        }
      );

      // Initial mount-scroll fires.
      expect(containerRef.current!.scrollTop).toBe(1000);

      // Messages cleared (e.g., loading state during task switch).
      rerender({ messageCount: 0, enabled: true });

      // New task's messages arrive — prevMessageCountRef was reset to 0,
      // so the 0→7 transition is seen as new content and scrolls.
      rerender({ messageCount: 7, enabled: true });
      expect(containerRef.current!.scrollTop).toBe(1000);

      // Layout grows after first scroll; deferred rAF scroll should re-pin.
      containerRef.current!.scrollHeight = 1200;
      act(() => {
        vi.advanceTimersByTime(16);
      });
      expect(containerRef.current!.scrollTop).toBe(1200);

      // Subsequent new-message scrolls use the hasNewContent path.
      rerender({ messageCount: 8, enabled: true });
      expect(containerRef.current!.scrollTop).toBe(1200);
      vi.useRealTimers();
    });

    it('should reset to bottom when resetKey changes without messageCount dropping to 0', () => {
      // Reproduces the cached-navigation bug: the component stays mounted
      // across a `resetKey` (sessionId/taskId) change, and the store swaps the
      // underlying messages directly (e.g. 40 → 25) with no intermediate
      // empty state. Without `resetKey`, hasScrolledOnMountRef stays latched
      // true from the previous context and the hook preserves the stale scroll
      // position instead of snapping to the bottom of the new context.
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount, resetKey }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: true,
            messageCount,
            resetKey,
          }),
        {
          initialProps: { messageCount: 40, resetKey: 'session-a' },
        }
      );

      // Session A: initial mount-scroll fires.
      expect(containerRef.current!.scrollTop).toBe(1000);

      // User has scrolled up / a prior render left the container away from
      // the bottom, then navigates to a cached session B whose messages swap
      // in directly — messageCount changes 40 → 25, never passing through 0.
      containerRef.current!.scrollTop = 250;
      rerender({ messageCount: 25, resetKey: 'session-b' });

      // resetKey change must be treated as a fresh visit: snap to bottom.
      expect(containerRef.current!.scrollTop).toBe(1000);

      // Subsequent new content in session B uses the normal hasNewContent path.
      rerender({ messageCount: 26, resetKey: 'session-b' });
      expect(containerRef.current!.scrollTop).toBe(1000);
    });

    it('should reset to bottom when resetKey changes but messageCount stays the same', () => {
      // Edge case from review: when switching between two contexts that happen
      // to have the same message count, resetKey is the ONLY hook input that
      // changes. The reset effect clears the latch, but the auto-scroll effect
      // must also re-run on resetKey so the cleared latch is acted upon —
      // otherwise the old scroll position is preserved.
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount, resetKey }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: true,
            messageCount,
            resetKey,
          }),
        {
          initialProps: { messageCount: 25, resetKey: 'session-a' },
        }
      );

      // Session A: initial mount-scroll fires.
      expect(containerRef.current!.scrollTop).toBe(1000);

      // Navigate to session B which also has exactly 25 messages. messageCount
      // is unchanged, so without resetKey in the auto-scroll dep array this
      // render would not re-scroll.
      containerRef.current!.scrollTop = 300;
      rerender({ messageCount: 25, resetKey: 'session-b' });
      expect(containerRef.current!.scrollTop).toBe(1000);
    });

    it('should re-pin to bottom on post-reset content growth after a same-count context switch', () => {
      // Edge case from review: after a resetKey change with unchanged
      // messageCount, lastScrollHeightRef must be refreshed too — otherwise it
      // still describes the previous (e.g. taller) thread. When the new
      // thread's markdown/images expand after the initial scroll, the
      // ResizeObserver would compare against that stale height, `grew` stays
      // false, and it never re-pins.
      vi.useFakeTimers();
      const { containerRef, endRef } = createMockRefs();

      // Context A is tall (scrollHeight 1500). After mount, the scroll-
      // detection effect snapshots lastScrollHeightRef = 1500.
      containerRef.current!.scrollHeight = 1500;
      const { rerender } = renderHook(
        ({ messageCount, resetKey }) =>
          useAutoScroll({ containerRef, endRef, enabled: true, messageCount, resetKey }),
        { initialProps: { messageCount: 25, resetKey: 'a' } }
      );
      expect(containerRef.current!.scrollTop).toBe(1500);

      // Switch to a shorter context B (same messageCount). Mutate the live
      // scrollHeight to model B's smaller content.
      containerRef.current!.scrollHeight = 800;
      rerender({ messageCount: 25, resetKey: 'b' });
      expect(containerRef.current!.scrollTop).toBe(800);

      // Flush the mount-scroll's deferred rAF (scrollToBottomAfterLayout) NOW,
      // while scrollHeight is still 800, so a later timer advance only fires
      // the ResizeObserver rAF we are about to trigger (otherwise the deferred
      // mount-scroll rAF would set scrollTop to whatever scrollHeight is at
      // flush time and mask the re-pin-under-test).
      act(() => {
        vi.advanceTimersByTime(16);
      });
      expect(containerRef.current!.scrollTop).toBe(800);

      // B's content grows after the initial scroll (markdown/images expand).
      containerRef.current!.scrollHeight = 900;
      act(() => {
        resizeObserverInstances[0]?.triggerResize();
        vi.advanceTimersByTime(16);
      });

      // With the snapshot refreshed, `grew` (900 > 800) is true and we re-pin
      // to the new bottom. Without the refresh, grew (900 > stale 1500) is
      // false and scrollTop stays 800.
      expect(containerRef.current!.scrollTop).toBe(900);
      vi.useRealTimers();
    });
  });

  describe('scroll position detection', () => {
    it('should report near bottom when close to scroll bottom', () => {
      const { containerRef, endRef, addEventListenerMock } = createMockRefs();

      // Position near bottom
      containerRef.current!.scrollTop = 400;
      containerRef.current!.scrollHeight = 1000;
      containerRef.current!.clientHeight = 500;
      // scrollHeight(1000) - scrollTop(400) - clientHeight(500) = 100 < 200 threshold

      renderHook(() =>
        useAutoScroll({
          containerRef,
          endRef,
          enabled: true,
          messageCount: 5,
        })
      );

      // Should have set up scroll listener
      expect(addEventListenerMock).toHaveBeenCalled();
    });

    it('should use custom nearBottomThreshold', () => {
      const { containerRef, endRef, addEventListenerMock } = createMockRefs();

      // Position that would be near bottom with 200 threshold but not with 50
      containerRef.current!.scrollTop = 350;
      containerRef.current!.scrollHeight = 1000;
      containerRef.current!.clientHeight = 500;
      // scrollHeight(1000) - scrollTop(350) - clientHeight(500) = 150

      renderHook(() =>
        useAutoScroll({
          containerRef,
          endRef,
          enabled: true,
          messageCount: 5,
          nearBottomThreshold: 50, // Custom threshold
        })
      );

      expect(addEventListenerMock).toHaveBeenCalled();
    });
  });

  describe('null ref handling', () => {
    it('should handle null containerRef', () => {
      const { endRef } = createMockRefs();
      const nullContainerRef = { current: null } as RefObject<HTMLDivElement>;

      // Should not throw
      const { result } = renderHook(() =>
        useAutoScroll({
          containerRef: nullContainerRef,
          endRef,
          enabled: true,
          messageCount: 0,
        })
      );

      expect(result.current.showScrollButton).toBe(false);
    });
  });

  describe('initial load reset', () => {
    it('should reset mount-scroll latch when isInitialLoad changes to true', () => {
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ isInitialLoad, messageCount }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: true,
            messageCount,
            isInitialLoad,
          }),
        {
          initialProps: { isInitialLoad: true, messageCount: 0 },
        }
      );

      // Initial load with messages
      rerender({ isInitialLoad: true, messageCount: 5 });
      expect(containerRef.current!.scrollTop).toBe(1000);

      // Switch to not initial load
      rerender({ isInitialLoad: false, messageCount: 5 });

      // Back to initial load (simulating new session)
      rerender({ isInitialLoad: true, messageCount: 0 });

      // New messages arrive
      rerender({ isInitialLoad: true, messageCount: 3 });
      expect(containerRef.current!.scrollTop).toBe(1000);
    });
  });

  describe('cleanup', () => {
    it('should clean up event listeners on unmount', () => {
      const { containerRef, endRef, removeEventListenerMock } = createMockRefs();

      const { unmount } = renderHook(() =>
        useAutoScroll({
          containerRef,
          endRef,
          enabled: true,
          messageCount: 5,
        })
      );

      unmount();

      expect(removeEventListenerMock).toHaveBeenCalled();
    });
  });

  describe('delayed ref setup', () => {
    it('should set up scroll detection after timeout when containerRef is initially null', async () => {
      vi.useFakeTimers();

      const { endRef } = createMockRefs();
      const addEventListenerMock = vi.fn();
      const removeEventListenerMock = vi.fn();

      // Start with null containerRef
      const containerRef = { current: null } as RefObject<HTMLDivElement>;

      const { unmount } = renderHook(() =>
        useAutoScroll({
          containerRef,
          endRef,
          enabled: true,
          messageCount: 0,
        })
      );

      // Now set the containerRef (simulating delayed DOM mounting)
      containerRef.current = {
        scrollTop: 0,
        scrollHeight: 1000,
        clientHeight: 500,
        addEventListener: addEventListenerMock,
        removeEventListener: removeEventListenerMock,
      } as unknown as HTMLDivElement;

      // Advance timers to trigger the delayed setup
      await vi.advanceTimersByTimeAsync(50);

      // Should have set up scroll listener after timeout
      expect(addEventListenerMock).toHaveBeenCalledWith('scroll', expect.any(Function), {
        passive: true,
      });

      unmount();
      vi.useRealTimers();
    });

    it('should cleanup timeout when unmounted before delay completes', () => {
      vi.useFakeTimers();

      const { endRef } = createMockRefs();
      const nullContainerRef = { current: null } as RefObject<HTMLDivElement>;

      const { unmount } = renderHook(() =>
        useAutoScroll({
          containerRef: nullContainerRef,
          endRef,
          enabled: true,
          messageCount: 0,
        })
      );

      // Unmount before timeout fires
      unmount();

      // Advance timers - should not throw
      vi.advanceTimersByTime(100);

      vi.useRealTimers();
    });
  });

  describe('content-growth re-anchor', () => {
    it('should re-pin to bottom when content grows while user is near bottom', () => {
      // Reproduces the "lands somewhere random" symptom: an initial
      // scroll-to-bottom fires, but then async content (markdown,
      // syntax highlighting, image loads) grows the scrollHeight after
      // the scroll, leaving the last messages stranded above the actual
      // bottom. The ResizeObserver path catches the growth and re-pins.
      const { containerRef, endRef } = createMockRefs();

      // Container is initially at bottom.
      containerRef.current!.scrollTop = 500;
      containerRef.current!.scrollHeight = 1000;
      containerRef.current!.clientHeight = 500;

      renderHook(() =>
        useAutoScroll({
          containerRef,
          endRef,
          enabled: true,
          messageCount: 5,
        })
      );

      // Simulate async content rendering: scrollHeight grows past the
      // container's previous bottom, but scrollTop hasn't been adjusted.
      containerRef.current!.scrollHeight = 1500;
      // scrollTop stays at 500 → user no longer at bottom. The
      // ResizeObserver should snap them back to the new bottom.

      vi.useFakeTimers();
      act(() => {
        resizeObserverInstances[0]?.triggerResize();
        vi.advanceTimersByTime(16);
      });
      vi.useRealTimers();

      // Container should have been scrolled to the new bottom.
      expect(containerRef.current!.scrollTop).toBe(1500);
    });

    it('should NOT re-pin to bottom when user has scrolled away from bottom', () => {
      // User intentionally scrolled up to read older content. Even if
      // content grows, we must not yank them back to the bottom.
      const { containerRef, endRef } = createMockRefs();

      // User is well above the bottom.
      containerRef.current!.scrollTop = 0;
      containerRef.current!.scrollHeight = 1000;
      containerRef.current!.clientHeight = 500;
      // scrollHeight - scrollTop - clientHeight = 500 > 200 threshold

      renderHook(() =>
        useAutoScroll({
          containerRef,
          endRef,
          enabled: true,
          messageCount: 0,
        })
      );

      // Content grows.
      containerRef.current!.scrollHeight = 1500;

      vi.useFakeTimers();
      act(() => {
        resizeObserverInstances[0]?.triggerResize();
        vi.advanceTimersByTime(16);
      });
      vi.useRealTimers();

      expect(containerRef.current!.scrollTop).toBe(0);
    });

    it('should NOT re-pin to bottom while older messages are being loaded', () => {
      // During load-older, ChatContainer's own useLayoutEffect is
      // preserving the user's anchored read position. The auto-scroll
      // hook must keep its hands off.
      const { containerRef, endRef } = createMockRefs();

      containerRef.current!.scrollTop = 500;
      containerRef.current!.scrollHeight = 1000;
      containerRef.current!.clientHeight = 500;

      const { rerender } = renderHook(
        ({ loadingOlder }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: false,
            messageCount: 5,
            isInitialLoad: true,
            loadingOlder,
          }),
        { initialProps: { loadingOlder: false } }
      );

      rerender({ loadingOlder: true });

      containerRef.current!.scrollHeight = 2000;

      vi.useFakeTimers();
      act(() => {
        resizeObserverInstances[0]?.triggerResize();
        vi.advanceTimersByTime(16);
      });
      vi.useRealTimers();

      expect(containerRef.current!.scrollTop).toBe(500);
    });
  });

  describe('ResizeObserver callback', () => {
    it('should update scroll state when ResizeObserver fires', () => {
      const { containerRef, endRef } = createMockRefs();

      // Position not near bottom initially
      containerRef.current!.scrollTop = 0;
      containerRef.current!.scrollHeight = 1000;
      containerRef.current!.clientHeight = 500;

      const { result } = renderHook(() =>
        useAutoScroll({
          containerRef,
          endRef,
          enabled: true,
          messageCount: 0,
        })
      );

      // Initially not near bottom (scrollHeight - scrollTop - clientHeight = 500 > 200)
      expect(result.current.showScrollButton).toBe(true);

      // Simulate content size change where user is now near bottom
      containerRef.current!.scrollTop = 400;
      // scrollHeight(1000) - scrollTop(400) - clientHeight(500) = 100 < 200 threshold

      // Trigger ResizeObserver callback (uses rAF internally for batching)
      vi.useFakeTimers();
      act(() => {
        resizeObserverInstances[0]?.triggerResize();
        // Flush the requestAnimationFrame scheduled by the ResizeObserver callback
        vi.advanceTimersByTime(16);
      });
      vi.useRealTimers();

      // Should now be near bottom
      expect(result.current.isNearBottom).toBe(true);
      expect(result.current.showScrollButton).toBe(false);
    });
  });

  describe('bounded settle-scroll (refresh / cold-mount)', () => {
    it('should keep re-pinning to the bottom across the settle window as content grows', () => {
      // Reproduces the refresh/cold-mount race: the immediate mount-scroll
      // fires, but then async content (markdown, code blocks, images,
      // banners, composer inset) grows the scrollHeight in bursts over the
      // next few hundred ms. A single mount-scroll strands the user above
      // the latest messages; the bounded settle re-pins until layout
      // settles, then stops so normal scroll behavior resumes.
      vi.useFakeTimers();
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount, isInitialLoad }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: true,
            messageCount,
            isInitialLoad,
          }),
        { initialProps: { messageCount: 0, isInitialLoad: true } }
      );

      // First non-empty content fires the immediate mount-scroll.
      rerender({ messageCount: 5, isInitialLoad: true });
      expect(containerRef.current!.scrollTop).toBe(1000);

      // Flush the same-frame re-pin (no growth yet).
      act(() => {
        vi.advanceTimersByTime(16);
      });
      expect(containerRef.current!.scrollTop).toBe(1000);

      // Late layout growth lands mid-window.
      containerRef.current!.scrollHeight = 1500;

      // Advancing past the tail re-pin delays catches the new bottom.
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(containerRef.current!.scrollTop).toBe(1500);

      // After the settle window closes, further growth is NOT re-pinned by
      // the settle — it self-terminates so day-to-day scroll is preserved.
      containerRef.current!.scrollHeight = 9999;
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(containerRef.current!.scrollTop).toBe(1500);
      vi.useRealTimers();
    });

    it('should cancel the settle when the user scrolls away during the window', () => {
      vi.useFakeTimers();
      const { containerRef, endRef, addEventListenerMock } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled: true,
            messageCount,
            isInitialLoad: false,
          }),
        { initialProps: { messageCount: 0 } }
      );

      rerender({ messageCount: 5 });
      expect(containerRef.current!.scrollTop).toBe(1000);

      // Grab the most recent 'wheel' gesture handler registered on the
      // container and invoke it — the user is intentionally scrolling away.
      const wheelCalls = addEventListenerMock.mock.calls.filter((c) => c[0] === 'wheel');
      expect(wheelCalls.length).toBeGreaterThan(0);
      const wheelHandler = wheelCalls[wheelCalls.length - 1][1] as () => void;
      act(() => {
        wheelHandler();
      });

      // Late growth + full window advance: the cancelled settle must NOT
      // yank the user back to the bottom.
      containerRef.current!.scrollHeight = 1500;
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(containerRef.current!.scrollTop).toBe(1000);
      vi.useRealTimers();
    });

    it('should cancel an in-flight settle when enabled flips false mid-settle', () => {
      // A caller (e.g. ChatContainer with a deep-link highlight) disables
      // tail-follow mid-settle; the remaining re-pins must be cancelled so
      // the caller's own scroll driver isn't fought.
      vi.useFakeTimers();
      const { containerRef, endRef } = createMockRefs();

      const { rerender } = renderHook(
        ({ messageCount, enabled }) =>
          useAutoScroll({
            containerRef,
            endRef,
            enabled,
            messageCount,
            isInitialLoad: false,
          }),
        { initialProps: { messageCount: 0, enabled: true } }
      );

      rerender({ messageCount: 5, enabled: true });
      expect(containerRef.current!.scrollTop).toBe(1000);

      // Growth + enabled flip mid-window.
      containerRef.current!.scrollHeight = 1500;
      rerender({ messageCount: 5, enabled: false });

      act(() => {
        vi.advanceTimersByTime(600);
      });
      // Settle cancelled; scrollTop stays at the immediate-scroll value.
      expect(containerRef.current!.scrollTop).toBe(1000);
      vi.useRealTimers();
    });

    it('should register wheel/touch/keydown gesture listeners to cancel the settle', () => {
      const { containerRef, endRef, addEventListenerMock } = createMockRefs();

      renderHook(() =>
        useAutoScroll({
          containerRef,
          endRef,
          enabled: true,
          messageCount: 5,
        })
      );

      const registered = addEventListenerMock.mock.calls.map((c) => c[0]);
      expect(registered).toEqual(
        expect.arrayContaining(['wheel', 'touchstart', 'touchmove', 'keydown'])
      );
    });
  });
});

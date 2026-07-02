/**
 * useAutoScroll Hook
 *
 * Manages auto-scroll behavior for chat containers.
 * Handles scroll position detection, scroll button visibility,
 * and automatic scrolling when new content arrives.
 *
 * @example
 * ```typescript
 * const messagesContainerRef = useRef<HTMLDivElement>(null);
 * const messagesEndRef = useRef<HTMLDivElement>(null);
 *
 * const { showScrollButton, scrollToBottom } = useAutoScroll({
 *   containerRef: messagesContainerRef,
 *   endRef: messagesEndRef,
 *   enabled: autoScroll,
 *   messageCount: messages.length,
 *   isInitialLoad,
 * });
 * ```
 */

import type { RefObject } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

export interface UseAutoScrollOptions {
  /** Ref to the scrollable container element */
  containerRef: RefObject<HTMLDivElement>;
  /** Ref to the element at the end of the content (for scrollIntoView) */
  endRef: RefObject<HTMLDivElement>;
  /** Whether auto-scroll is enabled */
  enabled: boolean;
  /** Current message count (used to detect new messages) */
  messageCount: number;
  /** Whether this is the initial load (always scrolls on initial load) */
  isInitialLoad?: boolean;
  /** Whether older messages are being loaded (prevents scroll during load) */
  loadingOlder?: boolean;
  /**
   * Identity key for the scrollable context (e.g. `sessionId` or `taskId`).
   * When this changes, the mount-scroll latch and message-count tracker are
   * reset so the next non-empty render is treated as a fresh "visit" and
   * scrolled to the bottom. Needed because a parent can swap the underlying
   * data in place (cached session/task navigation) without unmounting this
   * component and without the message count passing through 0 — in that case
   * the hook would otherwise keep the previous context's stale scroll
   * position instead of snapping to the latest messages.
   */
  resetKey?: string | null;
  /** Distance from bottom to consider "near bottom" (default: 200px) */
  nearBottomThreshold?: number;
}

export interface UseAutoScrollResult {
  /** Whether to show the scroll-to-bottom button */
  showScrollButton: boolean;
  /** Scroll to the bottom of the container */
  scrollToBottom: (smooth?: boolean) => void;
  /** Whether the user is near the bottom of the scroll container */
  isNearBottom: boolean;
}

/**
 * Hook for managing auto-scroll behavior in chat containers
 */
export function useAutoScroll({
  containerRef,
  endRef,
  enabled,
  messageCount,
  isInitialLoad = false,
  loadingOlder = false,
  resetKey,
  nearBottomThreshold = 200,
}: UseAutoScrollOptions): UseAutoScrollResult {
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const prevMessageCountRef = useRef<number>(0);
  // Tracks whether we've performed the first scroll-to-bottom on this mount.
  // Independent of the `isInitialLoad` prop because preact batches the
  // signal-driven `setIsInitialLoad(false)` and `setMessages(M)` updates into
  // a single render on cached-session navigation, so the prop-based check
  // would miss the transition entirely (the prop is already `false` by the
  // time `messageCount` first becomes non-zero).
  const hasScrolledOnMountRef = useRef(false);
  // Snapshot of `scrollHeight` from the previous handleScroll invocation —
  // used to detect content-size growth in the ResizeObserver path so we can
  // snap back to the bottom when async-rendered content (markdown, syntax
  // highlighting, image loads) grows the scroll height after our initial
  // scroll has already fired.
  const lastScrollHeightRef = useRef<number>(0);
  // Latched "near bottom" flag, kept in a ref so the ResizeObserver callback
  // can read the current value without re-binding on every state update.
  const isNearBottomRef = useRef<boolean>(true);
  // Mirror of `enabled` and `loadingOlder` for the same reason. The
  // ResizeObserver callback closes over these refs so it always sees the
  // current value rather than a stale closure capture.
  const enabledRef = useRef<boolean>(enabled);
  const loadingOlderRef = useRef<boolean>(loadingOlder);
  const deferredScrollRafRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  useLayoutEffect(() => {
    loadingOlderRef.current = loadingOlder;
  }, [loadingOlder]);

  // Scroll to bottom function - instant by default during streaming, smooth when user clicks.
  // Set the scroll container directly instead of relying on scrollIntoView alignment,
  // which interacts poorly with scroll-padding-bottom and can stop short of the true bottom.
  const scrollToBottom = useCallback(
    (smooth = false) => {
      const container = containerRef.current;
      if (container) {
        if (smooth) {
          container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
        } else {
          container.scrollTop = container.scrollHeight;
        }
        return;
      }

      endRef.current?.scrollIntoView({
        behavior: smooth ? 'smooth' : 'instant',
        block: 'end',
      });
    },
    [containerRef, endRef]
  );

  const scrollToBottomAfterLayout = useCallback(() => {
    if (deferredScrollRafRef.current !== null) {
      cancelAnimationFrame(deferredScrollRafRef.current);
    }

    deferredScrollRafRef.current = requestAnimationFrame(() => {
      deferredScrollRafRef.current = null;
      if (enabledRef.current && !loadingOlderRef.current) {
        scrollToBottom();
      }
    });
  }, [scrollToBottom]);

  // Detect scroll position to show/hide scroll button
  useEffect(() => {
    // Try to get container, with a fallback check after a brief delay if not immediately available
    let container = containerRef.current;

    if (!container) {
      // Schedule a retry after a brief moment to allow the ref to be populated
      const timeoutId = setTimeout(() => {
        container = containerRef.current;
        if (container) {
          setupScrollDetection(container);
        }
      }, 50);
      return () => clearTimeout(timeoutId);
    }

    function setupScrollDetection(container: HTMLDivElement) {
      const handleScroll = () => {
        const { scrollTop, scrollHeight, clientHeight } = container;
        const nearBottom = scrollHeight - scrollTop - clientHeight < nearBottomThreshold;
        isNearBottomRef.current = nearBottom;
        lastScrollHeightRef.current = scrollHeight;
        setIsNearBottom(nearBottom);
        setShowScrollButton(!nearBottom);
      };

      // Initial check
      handleScroll();

      // Use passive event listener for better scroll performance
      container.addEventListener('scroll', handleScroll, { passive: true });

      // Use ResizeObserver to update when rendered content changes size.
      // Observe both the scroll container and the content wrapper (endRef parent)
      // when available: composer padding changes affect container metrics, while
      // markdown/code rendering grows inner content without resizing the container.
      // Batch layout reads via rAF to avoid forced reflow on dirty layout.
      let rafId: number;
      const resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          const prevScrollHeight = lastScrollHeightRef.current;
          const grew = container.scrollHeight > prevScrollHeight;
          // If we were anchored at the bottom and content just grew —
          // e.g. markdown finished rendering, a code block expanded, an
          // image finished loading — re-pin the container to the
          // bottom so the last messages stay visible. We deliberately
          // skip this while older messages are being loaded, since
          // ChatContainer's own useLayoutEffect is responsible for
          // preserving the user's anchored read position there.
          if (
            grew &&
            isNearBottomRef.current &&
            !loadingOlderRef.current &&
            (enabledRef.current || !hasScrolledOnMountRef.current)
          ) {
            container.scrollTop = container.scrollHeight;
          }
          handleScroll();
        });
      });
      resizeObserver.observe(container);
      const contentWrapper = endRef.current?.parentElement;
      if (contentWrapper && contentWrapper !== container) {
        resizeObserver.observe(contentWrapper);
      }

      // Return cleanup function
      return () => {
        cancelAnimationFrame(rafId);
        container.removeEventListener('scroll', handleScroll);
        resizeObserver.disconnect();
      };
    }

    return setupScrollDetection(container);
  }, [nearBottomThreshold, messageCount, endRef]);

  // When loadingOlder transitions from true to false, skip the message-count delta
  // that was introduced by revealing older messages so that auto-scroll doesn't fire.
  //
  // Must run as a useLayoutEffect, declared BEFORE the auto-scroll layout
  // effect below, so that `prevMessageCountRef` is updated to the new count
  // before the auto-scroll effect reads it. With the auto-scroll path moved
  // to useLayoutEffect (see below), an ordinary useEffect would fire too
  // late and the auto-scroll would race ahead with a stale `prev`, scrolling
  // the user to the bottom and clobbering ChatContainer's scroll-position
  // restore.
  const prevLoadingOlderRef = useRef(loadingOlder);
  useLayoutEffect(() => {
    if (prevLoadingOlderRef.current && !loadingOlder) {
      prevMessageCountRef.current = messageCount;
    }
    prevLoadingOlderRef.current = loadingOlder;
  }, [loadingOlder, messageCount]);

  // Reset the mount-scroll latch and message-count tracker when the scrollable
  // context changes (e.g. a parent swaps `sessionId`/`taskId` in place without
  // remounting). Declared as a useLayoutEffect BEFORE the auto-scroll effect
  // below so the refs are reset before that effect reads them on the same
  // commit. Without this, cached navigation where `messageCount` jumps
  // directly from one non-zero value to another (e.g. 40 → 25) without
  // passing through 0 would leave `hasScrolledOnMountRef` latched true from
  // the previous context, so the hook would preserve the stale scroll
  // position instead of snapping to the bottom of the new context.
  const prevResetKeyRef = useRef<string | null | undefined>(resetKey);
  useLayoutEffect(() => {
    if (prevResetKeyRef.current !== resetKey) {
      prevResetKeyRef.current = resetKey;
      hasScrolledOnMountRef.current = false;
      prevMessageCountRef.current = 0;
      isNearBottomRef.current = true;
    }
  }, [resetKey]);

  // Auto-scroll on new messages.
  //
  // Uses `useLayoutEffect` so the scroll happens synchronously after DOM
  // mutation but before paint. This eliminates the visible mid-conversation
  // flicker that occurs when navigating back to a session whose messages are
  // already cached in the store: with `useEffect` the browser would paint
  // the messages at the top of the container first, then scroll on the next
  // frame. With `useLayoutEffect` the scroll lands before the first paint.
  useLayoutEffect(() => {
    const hasNewContent = messageCount > prevMessageCountRef.current;

    // Skip while older messages are being prepended — ChatContainer has a
    // dedicated useLayoutEffect that anchors the user to the message they
    // were viewing before pagination. Auto-scrolling here would yank them
    // to the bottom and clobber that restore.
    if (loadingOlder) {
      prevMessageCountRef.current = messageCount;
      return;
    }

    // When the message list is cleared (task switch, navigation),
    // reset the previous-count tracker so the next non-zero count is
    // seen as new content. Without this, a component that re-renders
    // in place (no key change) retains a stale prev count and the
    // 0→M transition is treated as a decrease, not new content.
    if (messageCount === 0) {
      prevMessageCountRef.current = 0;
      return;
    }

    // First scroll on mount: when messages first become non-empty on this
    // mount, scroll to the bottom — even if `enabled` is false. This is a
    // "navigation/visit" scroll, not an auto-scroll on new content; the
    // user's `enabled` (autoScroll) preference only governs SUBSEQUENT
    // scrolling for new messages.
    //
    // Tracked via a ref instead of the `isInitialLoad` prop because preact
    // batches the signal-driven `setIsInitialLoad(false)` and
    // `setMessages(M)` updates into a single render on cached-session
    // re-mounts, so the prop-based check would miss the transition
    // entirely (the prop is already `false` by the time `messageCount`
    // first becomes non-zero).
    if (!hasScrolledOnMountRef.current && messageCount > 0) {
      hasScrolledOnMountRef.current = true;
      prevMessageCountRef.current = messageCount;
      isNearBottomRef.current = true;
      // Gate the initial-load tail-follow on `enabled`. When a caller sets
      // `enabled: false` during initial load (e.g. ChatContainer does this
      // when `highlightMessageId` is set so that `useScrollToMessage` can
      // scroll to the deep-linked row without racing against this scroll),
      // suppress the auto-scroll and let the caller drive.
      if (enabled || !isInitialLoad) {
        scrollToBottom();
        if (enabled) {
          scrollToBottomAfterLayout();
        }
      }
      return;
    }

    // Only auto-scroll for new messages if enabled
    if (enabled && hasNewContent) {
      scrollToBottom();
      scrollToBottomAfterLayout();
    }

    prevMessageCountRef.current = messageCount;
  }, [
    messageCount,
    isInitialLoad,
    loadingOlder,
    enabled,
    resetKey,
    scrollToBottom,
    scrollToBottomAfterLayout,
  ]);

  // Reset the mount-scroll latch when `isInitialLoad` flips back to true.
  // This preserves the existing reset semantic — a parent can signal "treat
  // the next non-empty messageCount as a fresh load" by toggling the prop —
  // without coupling the scroll trigger itself to the prop's timing.
  useEffect(() => {
    if (isInitialLoad) {
      hasScrolledOnMountRef.current = false;
    }
  }, [isInitialLoad]);

  useEffect(() => {
    return () => {
      if (deferredScrollRafRef.current !== null) {
        cancelAnimationFrame(deferredScrollRafRef.current);
      }
    };
  }, []);

  return {
    showScrollButton,
    scrollToBottom,
    isNearBottom,
  };
}

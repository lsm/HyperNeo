import type { RefObject } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

const SETTLE_REPIN_DELAYS = [120, 260, 420];

export interface UseAutoScrollOptions {
  containerRef: RefObject<HTMLDivElement>;
  endRef: RefObject<HTMLDivElement>;
  enabled: boolean;
  messageCount: number;
  isInitialLoad?: boolean;
  loadingOlder?: boolean;
  resetKey?: string | null;
  nearBottomThreshold?: number;
}

export interface UseAutoScrollResult {
  showScrollButton: boolean;
  scrollToBottom: (smooth?: boolean) => void;
  isNearBottom: boolean;
}

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
  const hasScrolledOnMountRef = useRef(false);
  const lastScrollHeightRef = useRef<number>(0);
  const isNearBottomRef = useRef<boolean>(true);
  const enabledRef = useRef<boolean>(enabled);
  const loadingOlderRef = useRef<boolean>(loadingOlder);
  const deferredScrollRafRef = useRef<number | null>(null);
  const settleTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const settleRafsRef = useRef<number[]>([]);
  const userInterruptedSettleRef = useRef(false);
  useLayoutEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  useLayoutEffect(() => {
    loadingOlderRef.current = loadingOlder;
  }, [loadingOlder]);

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

  const cancelSettleScroll = useCallback(() => {
    for (const timer of settleTimersRef.current) {
      clearTimeout(timer);
    }
    for (const raf of settleRafsRef.current) {
      cancelAnimationFrame(raf);
    }
    settleTimersRef.current = [];
    settleRafsRef.current = [];
  }, []);

  const runSettleScroll = useCallback(() => {
    cancelSettleScroll();
    userInterruptedSettleRef.current = false;

    const repin = () => {
      if (userInterruptedSettleRef.current) return;
      const raf = requestAnimationFrame(() => {
        if (userInterruptedSettleRef.current) return;
        if (enabledRef.current && !loadingOlderRef.current) {
          scrollToBottom();
        }
      });
      settleRafsRef.current.push(raf);
    };

    scrollToBottom();
    repin();

    for (const delay of SETTLE_REPIN_DELAYS) {
      settleTimersRef.current.push(setTimeout(repin, delay));
    }
  }, [cancelSettleScroll, scrollToBottom]);

  useEffect(() => {
    let container = containerRef.current;
    let teardown: (() => void) | undefined;

    if (!container) {
      const timeoutId = setTimeout(() => {
        container = containerRef.current;
        if (container) {
          teardown = setupScrollDetection(container);
        }
      }, 50);
      return () => {
        clearTimeout(timeoutId);
        teardown?.();
      };
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

      handleScroll();

      container.addEventListener('scroll', handleScroll, { passive: true });

      let rafId: number;
      const resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          const prevScrollHeight = lastScrollHeightRef.current;
          const grew = container.scrollHeight > prevScrollHeight;
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

      const cancelSettleOnGesture = () => {
        userInterruptedSettleRef.current = true;
        cancelSettleScroll();
      };
      const cancelSettleOnKey = (e: KeyboardEvent) => {
        if (
          e.key === 'PageUp' ||
          e.key === 'PageDown' ||
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown' ||
          e.key === 'Home' ||
          e.key === 'End'
        ) {
          cancelSettleOnGesture();
        }
      };
      container.addEventListener('wheel', cancelSettleOnGesture, { passive: true });
      container.addEventListener('touchstart', cancelSettleOnGesture, { passive: true });
      container.addEventListener('touchmove', cancelSettleOnGesture, { passive: true });
      container.addEventListener('keydown', cancelSettleOnKey, { passive: true });

      return () => {
        cancelAnimationFrame(rafId);
        container.removeEventListener('scroll', handleScroll);
        container.removeEventListener('wheel', cancelSettleOnGesture);
        container.removeEventListener('touchstart', cancelSettleOnGesture);
        container.removeEventListener('touchmove', cancelSettleOnGesture);
        container.removeEventListener('keydown', cancelSettleOnKey);
        resizeObserver.disconnect();
      };
    }

    teardown = setupScrollDetection(container);
    return () => {
      teardown?.();
    };
  }, [nearBottomThreshold, messageCount, endRef]);

  const prevLoadingOlderRef = useRef(loadingOlder);
  useLayoutEffect(() => {
    if (prevLoadingOlderRef.current && !loadingOlder) {
      prevMessageCountRef.current = messageCount;
    }
    prevLoadingOlderRef.current = loadingOlder;
  }, [loadingOlder, messageCount]);

  const prevResetKeyRef = useRef<string | null | undefined>(resetKey);
  useLayoutEffect(() => {
    if (prevResetKeyRef.current !== resetKey) {
      prevResetKeyRef.current = resetKey;
      hasScrolledOnMountRef.current = false;
      prevMessageCountRef.current = 0;
      isNearBottomRef.current = true;
      lastScrollHeightRef.current = containerRef.current?.scrollHeight ?? 0;
    }
  }, [resetKey]);

  useLayoutEffect(() => {
    const hasNewContent = messageCount > prevMessageCountRef.current;

    if (loadingOlder) {
      prevMessageCountRef.current = messageCount;
      return;
    }

    if (messageCount === 0) {
      prevMessageCountRef.current = 0;
      return;
    }

    if (!hasScrolledOnMountRef.current && messageCount > 0) {
      hasScrolledOnMountRef.current = true;
      prevMessageCountRef.current = messageCount;
      isNearBottomRef.current = true;
      if (enabled || !isInitialLoad) {
        if (enabled) {
          runSettleScroll();
        } else {
          scrollToBottom();
        }
      }
      return;
    }

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
    runSettleScroll,
  ]);

  useEffect(() => {
    if (isInitialLoad) {
      hasScrolledOnMountRef.current = false;
    }
  }, [isInitialLoad]);

  useLayoutEffect(() => {
    if (!enabled || loadingOlder) {
      cancelSettleScroll();
    }
  }, [enabled, loadingOlder, cancelSettleScroll]);

  useEffect(() => {
    return () => {
      if (deferredScrollRafRef.current !== null) {
        cancelAnimationFrame(deferredScrollRafRef.current);
      }
      cancelSettleScroll();
    };
  }, [cancelSettleScroll]);

  return {
    showScrollButton,
    scrollToBottom,
    isNearBottom,
  };
}

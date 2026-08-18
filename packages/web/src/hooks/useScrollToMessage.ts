import type { RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

export interface UseScrollToMessageOptions {
  containerRef: RefObject<HTMLElement>;
  messageId: string | undefined | null;
  messageCount: number;
  isInitialLoad?: boolean;
  highlightDurationMs?: number;
  settleWindowMs?: number;
  onAnchored?: (messageId: string) => void;
}

const HIGHLIGHT_CLASSES = [
  'ring-2',
  'ring-amber-400/70',
  'ring-offset-2',
  'ring-offset-dark-900',
  'rounded-lg',
  'transition-shadow',
  'duration-700',
] as const;

const DEFAULT_HIGHLIGHT_DURATION_MS = 5000;
const DEFAULT_SETTLE_WINDOW_MS = 250;

export function useScrollToMessage({
  containerRef,
  messageId,
  messageCount,
  isInitialLoad = false,
  highlightDurationMs = DEFAULT_HIGHLIGHT_DURATION_MS,
  settleWindowMs = DEFAULT_SETTLE_WINDOW_MS,
  onAnchored,
}: UseScrollToMessageOptions): void {
  const activeMessageIdRef = useRef<string | null>(null);
  const anchoredMessageIdRef = useRef<string | null>(null);
  const highlightedElRef = useRef<HTMLElement | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const runIdRef = useRef(0);
  const onAnchoredRef = useRef(onAnchored);

  useEffect(() => {
    onAnchoredRef.current = onAnchored;
  }, [onAnchored]);

  const clearSettleTimers = () => {
    for (const id of settleTimersRef.current) clearTimeout(id);
    settleTimersRef.current = [];
  };

  const clearFadeTimer = () => {
    if (fadeTimerRef.current) {
      clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
  };

  const clearHighlight = () => {
    if (highlightedElRef.current) {
      highlightedElRef.current.classList.remove(...HIGHLIGHT_CLASSES);
      highlightedElRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      runIdRef.current += 1;
      clearSettleTimers();
      clearFadeTimer();
      clearHighlight();
      activeMessageIdRef.current = null;
      anchoredMessageIdRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!messageId) {
      if (!anchoredMessageIdRef.current) {
        runIdRef.current += 1;
        clearSettleTimers();
        activeMessageIdRef.current = null;
      }
      return;
    }

    if (activeMessageIdRef.current !== messageId) {
      runIdRef.current += 1;
      clearSettleTimers();
      clearFadeTimer();
      clearHighlight();
      activeMessageIdRef.current = messageId;
      anchoredMessageIdRef.current = null;
    }

    if (isInitialLoad) return;
    if (anchoredMessageIdRef.current === messageId) return;

    const container = containerRef.current;
    if (!container) return;

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    clearSettleTimers();

    const findTarget = (): HTMLElement | null =>
      container.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);

    const anchor = (): HTMLElement | null => {
      if (runIdRef.current !== runId) return null;
      const target = findTarget();
      if (!target) return null;
      target.scrollIntoView({ behavior: 'auto', block: 'center' });
      if (highlightedElRef.current !== target) {
        clearHighlight();
        target.classList.add(...HIGHLIGHT_CLASSES);
        highlightedElRef.current = target;
      }
      if (anchoredMessageIdRef.current !== messageId) {
        anchoredMessageIdRef.current = messageId;
        clearFadeTimer();
        fadeTimerRef.current = setTimeout(() => {
          clearHighlight();
          fadeTimerRef.current = null;
        }, highlightDurationMs);
        onAnchoredRef.current?.(messageId);
      }
      return target;
    };

    anchor();

    const scheduleSettleRetries = () => {
      const delays = [16, 64, settleWindowMs];
      for (const delay of delays) {
        const id = setTimeout(() => {
          anchor();
        }, delay);
        settleTimersRef.current.push(id);
      }
    };
    scheduleSettleRetries();
  }, [messageId, isInitialLoad, messageCount, highlightDurationMs, settleWindowMs, containerRef]);
}

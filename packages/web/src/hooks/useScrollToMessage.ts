/**
 * useScrollToMessage Hook
 *
 * Native, first-class "deep-link to a specific message" support for chat
 * containers. Pass a `messageId` (matched against `data-message-id` on a
 * descendant element) and the hook:
 *
 *   1. Scrolls the matching element to the vertical center of the container.
 *   2. Applies a temporary amber ring so the user can spot it.
 *   3. Re-anchors a couple of times during a short settling window to handle
 *      late-arriving layout (lazy-loaded rows, image/font loads, etc.).
 *   4. Re-runs whenever `messageCount` changes until the first successful
 *      anchor, so streamed messages can still be located if the target row is
 *      appended after the deep link was set.
 *
 * Robustness considerations:
 *
 * - Uses `behavior: 'auto'` (instant) instead of `'smooth'`. Smooth scroll
 *   animations are interruptible — if anything else (the auto-scroll-to-
 *   bottom hook in particular) issues another `scrollTo`/`scrollIntoView`
 *   while the smooth animation is still running, the target ends up
 *   stranded off-screen. Instant scroll is deterministic.
 *
 * - The settling window is intentionally short (~250ms) and only re-anchors
 *   on a fixed schedule, so it does not fight the user if they immediately
 *   start scrolling after the deep link resolves.
 *
 * @example
 * ```typescript
 * const containerRef = useRef<HTMLDivElement>(null);
 * useScrollToMessage({
 *   containerRef,
 *   messageId: deepLinkUuid,
 *   messageCount: messages.length,
 *   isInitialLoad,
 * });
 * ```
 */

import type { RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

export interface UseScrollToMessageOptions {
  /** Ref to the scrollable container element. */
  containerRef: RefObject<HTMLElement>;
  /**
   * Id of the target message — matched against the `data-message-id`
   * attribute on a descendant of `containerRef`. Pass `undefined`,
   * `null`, or empty string to disable the hook.
   */
  messageId: string | undefined | null;
  /**
   * Current number of rendered messages. The hook re-runs when this
   * changes so streaming/late-arriving rows can still be located.
   */
  messageCount: number;
  /**
   * If true, the hook is suppressed (e.g. while initial-load auto-scroll
   * is still positioning the viewport). The hook fires as soon as this
   * becomes false.
   */
  isInitialLoad?: boolean;
  /**
   * How long the highlight ring stays visible. Default 5000ms.
   */
  highlightDurationMs?: number;
  /**
   * Settling window during which the hook will re-attempt the scroll
   * (e.g. to handle layout shifts from images/fonts loading). Default
   * 250ms. Kept short so the user can scroll freely after that.
   */
  settleWindowMs?: number;
  /**
   * Called once after the target message is first found and anchored.
   * Useful for clearing deep-link state while allowing the highlight timer
   * owned by this hook to finish normally.
   */
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
      // Instant scroll — deterministic, can't be cancelled mid-animation.
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

    // Initial attempt.
    anchor();

    // Re-anchor on a short fixed schedule to absorb layout shifts from
    // late-loading content. Does not run for long enough to fight a user
    // who scrolls immediately after the deep link resolves.
    const scheduleSettleRetries = () => {
      const delays = [16, 64, settleWindowMs]; // ~next frame, mid-settle, end-of-settle
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

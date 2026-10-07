import type { RefObject } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

const AT_BOTTOM_PX = 4;
const USER_SCROLL_WINDOW_MS = 600;
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' ']);

export interface UseAutoScrollOptions {
  containerRef: RefObject<HTMLDivElement>;
  endRef: RefObject<HTMLDivElement>;
  enabled?: boolean;
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

export function followAfterScroll(
  following: boolean,
  userScrolling: boolean,
  scrolledUp: boolean,
  distanceFromBottom: number,
  nearBottomThreshold: number
): boolean {
  if (!userScrolling) return following;
  if (scrolledUp) return distanceFromBottom < AT_BOTTOM_PX;
  return following || distanceFromBottom < nearBottomThreshold;
}

export function useAutoScroll({
  containerRef,
  endRef,
  enabled = true,
  messageCount,
  isInitialLoad = false,
  loadingOlder = false,
  resetKey,
  nearBottomThreshold = 200,
}: UseAutoScrollOptions): UseAutoScrollResult {
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const followingRef = useRef(true);
  const landedRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const pausedRef = useRef(!enabled || loadingOlder);
  pausedRef.current = !enabled || loadingOlder;

  const pin = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    lastScrollTopRef.current = container.scrollTop;
  }, [containerRef]);

  const scrollToBottom = useCallback(
    (smooth = false) => {
      followingRef.current = true;
      const container = containerRef.current;
      if (!container) {
        endRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant', block: 'end' });
        return;
      }
      if (smooth) container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      else pin();
    },
    [containerRef, endRef, pin]
  );

  const hasContent = messageCount > 0;
  useEffect(() => {
    const setup = (container: HTMLDivElement) => {
      let lastUserInputAt = Number.NEGATIVE_INFINITY;
      let pointerDown = false;
      const markInput = () => {
        lastUserInputAt = performance.now();
      };
      const onKey = (event: KeyboardEvent) => {
        if (SCROLL_KEYS.has(event.key)) markInput();
      };
      const onPointerDown = () => {
        pointerDown = true;
        markInput();
      };
      const onPointerUp = () => {
        pointerDown = false;
        markInput();
      };
      const onScroll = () => {
        const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
        const userScrolling =
          pointerDown || performance.now() - lastUserInputAt < USER_SCROLL_WINDOW_MS;
        followingRef.current = followAfterScroll(
          followingRef.current,
          userScrolling,
          container.scrollTop < lastScrollTopRef.current - 1,
          distance,
          nearBottomThreshold
        );
        lastScrollTopRef.current = container.scrollTop;
        setIsNearBottom(distance < nearBottomThreshold);
        setShowScrollButton(distance >= nearBottomThreshold);
      };
      const follow = () => {
        if (followingRef.current && !pausedRef.current) pin();
        onScroll();
      };
      if (!landedRef.current && !pausedRef.current)
        followingRef.current =
          container.scrollHeight - container.scrollTop - container.clientHeight <
          nearBottomThreshold;
      lastScrollTopRef.current = container.scrollTop;
      onScroll();
      container.addEventListener('scroll', onScroll, { passive: true });
      container.addEventListener('wheel', markInput, { passive: true });
      container.addEventListener('touchmove', markInput, { passive: true });
      container.addEventListener('keydown', onKey, { passive: true });
      container.addEventListener('pointerdown', onPointerDown, { passive: true });
      window.addEventListener('pointerup', onPointerUp, { passive: true });
      const observer = new ResizeObserver(follow);
      observer.observe(container);
      const content = endRef.current?.parentElement;
      if (content && content !== container) observer.observe(content);
      const observeChildren = () => {
        for (const child of Array.from(container.children ?? [])) observer.observe(child);
      };
      observeChildren();
      const children = container instanceof Element ? new MutationObserver(observeChildren) : null;
      children?.observe(container, { childList: true });
      return () => {
        container.removeEventListener('scroll', onScroll);
        container.removeEventListener('wheel', markInput);
        container.removeEventListener('touchmove', markInput);
        container.removeEventListener('keydown', onKey);
        container.removeEventListener('pointerdown', onPointerDown);
        window.removeEventListener('pointerup', onPointerUp);
        children?.disconnect();
        observer.disconnect();
      };
    };
    const container = containerRef.current;
    if (container) return setup(container);
    let teardown: (() => void) | undefined;
    const retry = setInterval(() => {
      if (!containerRef.current) return;
      clearInterval(retry);
      teardown = setup(containerRef.current);
    }, 50);
    return () => {
      clearInterval(retry);
      teardown?.();
    };
  }, [containerRef, endRef, nearBottomThreshold, pin, hasContent]);

  useLayoutEffect(() => {
    followingRef.current = true;
    landedRef.current = false;
    lastScrollTopRef.current = 0;
  }, [resetKey]);

  useLayoutEffect(() => {
    if (!enabled) followingRef.current = false;
  }, [enabled]);

  useLayoutEffect(() => {
    if (!hasContent) return;
    if (loadingOlder) return;
    if (!landedRef.current) {
      landedRef.current = true;
      if (pausedRef.current && isInitialLoad) return;
      if (!pausedRef.current) followingRef.current = true;
    } else if (!followingRef.current || pausedRef.current) {
      return;
    }
    pin();
    const frame = requestAnimationFrame(() => {
      if (followingRef.current && !pausedRef.current) pin();
    });
    return () => cancelAnimationFrame(frame);
  }, [messageCount, hasContent, resetKey, enabled, loadingOlder, pin]);

  return { showScrollButton, scrollToBottom, isNearBottom };
}

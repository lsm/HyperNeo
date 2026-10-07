// @ts-nocheck

import { renderHook, act } from '@testing-library/preact';
import type { RefObject } from 'preact';

import { followAfterScroll, useAutoScroll } from '../useAutoScroll.ts';

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

let resizeObserverInstances: MockResizeObserver[] = [];

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
  triggerResize() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

describe('useAutoScroll', () => {
  beforeEach(() => {
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

      rerender({ messageCount: 5, isInitialLoad: true });
      expect(containerRef.current!.scrollTop).toBe(1000);

      containerRef.current!.scrollHeight = 1200;
      act(() => {
        vi.advanceTimersByTime(16);
      });
      expect(containerRef.current!.scrollTop).toBe(1200);
      vi.useRealTimers();
    });

    it('should NOT force-scroll on initial load when enabled=false (deep-link case)', () => {
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

      const baselineScroll = containerRef.current!.scrollTop;

      rerender({ messageCount: 6 });

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

      expect(containerRef.current!.scrollTop).toBe(0);

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

      const baselineScroll = containerRef.current!.scrollTop;

      rerender({ messageCount: 55, loadingOlder: true });

      rerender({ messageCount: 55, loadingOlder: false });
      expect(containerRef.current!.scrollTop).toBe(baselineScroll);
    });

    it('should not auto-scroll across a load-older transition where messageCount also increases', () => {
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

      const baselineScroll = containerRef.current!.scrollTop;

      rerender({ messageCount: 200, loadingOlder: true });

      rerender({ messageCount: 250, loadingOlder: false });
      expect(containerRef.current!.scrollTop).toBe(baselineScroll);
    });

    it('should scroll on first non-empty messageCount even when isInitialLoad is already false', () => {
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
          initialProps: { messageCount: 0, isInitialLoad: false },
        }
      );

      rerender({ messageCount: 12, isInitialLoad: false });
      expect(containerRef.current!.scrollTop).toBe(1000);
    });

    it('should scroll on first non-empty messageCount even when enabled is false', () => {
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

      rerender({ messageCount: 5 });
      expect(containerRef.current!.scrollTop).toBe(1000);
    });

    it('should scroll to bottom on task switch without remount (messageCount N → 0 → M)', () => {
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

      expect(containerRef.current!.scrollTop).toBe(1000);

      rerender({ messageCount: 0, isInitialLoad: true });

      rerender({ messageCount: 15, isInitialLoad: false });

      expect(containerRef.current!.scrollTop).toBe(1000);
    });

    it('should scroll to bottom on task switch when new task has fewer messages', () => {
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
          initialProps: { messageCount: 50, isInitialLoad: false },
        }
      );

      expect(containerRef.current!.scrollTop).toBe(1000);

      rerender({ messageCount: 0, isInitialLoad: true });

      rerender({ messageCount: 5, isInitialLoad: false });

      expect(containerRef.current!.scrollTop).toBe(1000);
    });

    it('should scroll on repeated task switches (N → 0 → M → 0 → K)', () => {
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

      expect(containerRef.current!.scrollTop).toBe(1000);

      rerender({ messageCount: 0, isInitialLoad: true });
      rerender({ messageCount: 20, isInitialLoad: false });
      expect(containerRef.current!.scrollTop).toBe(1000);

      rerender({ messageCount: 0, isInitialLoad: true });
      rerender({ messageCount: 3, isInitialLoad: false });
      expect(containerRef.current!.scrollTop).toBe(1000);
    });

    it('should scroll on new content after messageCount drops to 0', () => {
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
          initialProps: { messageCount: 10, enabled: true },
        }
      );

      expect(containerRef.current!.scrollTop).toBe(1000);

      rerender({ messageCount: 0, enabled: true });

      rerender({ messageCount: 7, enabled: true });
      expect(containerRef.current!.scrollTop).toBe(1000);

      containerRef.current!.scrollHeight = 1200;
      act(() => {
        vi.advanceTimersByTime(16);
      });
      expect(containerRef.current!.scrollTop).toBe(1200);

      rerender({ messageCount: 8, enabled: true });
      expect(containerRef.current!.scrollTop).toBe(1200);
      vi.useRealTimers();
    });

    it('should reset to bottom when resetKey changes without messageCount dropping to 0', () => {
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

      expect(containerRef.current!.scrollTop).toBe(1000);

      containerRef.current!.scrollTop = 250;
      rerender({ messageCount: 25, resetKey: 'session-b' });

      expect(containerRef.current!.scrollTop).toBe(1000);

      rerender({ messageCount: 26, resetKey: 'session-b' });
      expect(containerRef.current!.scrollTop).toBe(1000);
    });

    it('should reset to bottom when resetKey changes but messageCount stays the same', () => {
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

      expect(containerRef.current!.scrollTop).toBe(1000);

      containerRef.current!.scrollTop = 300;
      rerender({ messageCount: 25, resetKey: 'session-b' });
      expect(containerRef.current!.scrollTop).toBe(1000);
    });

    it('should re-pin to bottom on post-reset content growth after a same-count context switch', () => {
      vi.useFakeTimers();
      const { containerRef, endRef } = createMockRefs();

      containerRef.current!.scrollHeight = 1500;
      const { rerender } = renderHook(
        ({ messageCount, resetKey }) =>
          useAutoScroll({ containerRef, endRef, enabled: true, messageCount, resetKey }),
        { initialProps: { messageCount: 25, resetKey: 'a' } }
      );
      expect(containerRef.current!.scrollTop).toBe(1500);

      containerRef.current!.scrollHeight = 800;
      rerender({ messageCount: 25, resetKey: 'b' });
      expect(containerRef.current!.scrollTop).toBe(800);

      act(() => {
        vi.advanceTimersByTime(16);
      });
      expect(containerRef.current!.scrollTop).toBe(800);

      containerRef.current!.scrollHeight = 900;
      act(() => {
        resizeObserverInstances[0]?.triggerResize();
        vi.advanceTimersByTime(16);
      });

      expect(containerRef.current!.scrollTop).toBe(900);
      vi.useRealTimers();
    });
  });

  describe('scroll position detection', () => {
    it('should report near bottom when close to scroll bottom', () => {
      const { containerRef, endRef, addEventListenerMock } = createMockRefs();

      containerRef.current!.scrollTop = 400;
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

      expect(addEventListenerMock).toHaveBeenCalled();
    });

    it('should use custom nearBottomThreshold', () => {
      const { containerRef, endRef, addEventListenerMock } = createMockRefs();

      containerRef.current!.scrollTop = 350;
      containerRef.current!.scrollHeight = 1000;
      containerRef.current!.clientHeight = 500;

      renderHook(() =>
        useAutoScroll({
          containerRef,
          endRef,
          enabled: true,
          messageCount: 5,
          nearBottomThreshold: 50,
        })
      );

      expect(addEventListenerMock).toHaveBeenCalled();
    });
  });

  describe('null ref handling', () => {
    it('should handle null containerRef', () => {
      const { endRef } = createMockRefs();
      const nullContainerRef = { current: null } as RefObject<HTMLDivElement>;

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

      rerender({ isInitialLoad: true, messageCount: 5 });
      expect(containerRef.current!.scrollTop).toBe(1000);

      rerender({ isInitialLoad: false, messageCount: 5 });

      rerender({ isInitialLoad: true, messageCount: 0 });

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

      const containerRef = { current: null } as RefObject<HTMLDivElement>;

      const { unmount } = renderHook(() =>
        useAutoScroll({
          containerRef,
          endRef,
          enabled: true,
          messageCount: 0,
        })
      );

      containerRef.current = {
        scrollTop: 0,
        scrollHeight: 1000,
        clientHeight: 500,
        addEventListener: addEventListenerMock,
        removeEventListener: removeEventListenerMock,
      } as unknown as HTMLDivElement;

      await vi.advanceTimersByTimeAsync(50);

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

      unmount();

      vi.advanceTimersByTime(100);

      vi.useRealTimers();
    });

    it('should remove listeners installed via the retry-timeout path on unmount (no leak)', () => {
      vi.useFakeTimers();

      const { endRef } = createMockRefs();
      const addEventListenerMock = vi.fn(() => {});
      const removeEventListenerMock = vi.fn(() => {});
      const containerRef = { current: null } as RefObject<HTMLDivElement>;

      const { unmount } = renderHook(() =>
        useAutoScroll({
          containerRef,
          endRef,
          enabled: true,
          messageCount: 0,
        })
      );

      containerRef.current = {
        scrollTop: 0,
        scrollHeight: 1000,
        clientHeight: 500,
        addEventListener: addEventListenerMock,
        removeEventListener: removeEventListenerMock,
      } as unknown as HTMLDivElement;

      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(addEventListenerMock).toHaveBeenCalledWith('scroll', expect.any(Function), {
        passive: true,
      });
      expect(removeEventListenerMock).not.toHaveBeenCalled();

      unmount();
      expect(removeEventListenerMock).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('content-growth re-anchor', () => {
    it('should re-pin to bottom when content grows while user is near bottom', () => {
      const { containerRef, endRef } = createMockRefs();

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

      containerRef.current!.scrollHeight = 1500;

      vi.useFakeTimers();
      act(() => {
        resizeObserverInstances[0]?.triggerResize();
        vi.advanceTimersByTime(16);
      });
      vi.useRealTimers();

      expect(containerRef.current!.scrollTop).toBe(1500);
    });

    it('should NOT re-pin to bottom when user has scrolled away from bottom', () => {
      const { containerRef, endRef } = createMockRefs();

      containerRef.current!.scrollTop = 0;
      containerRef.current!.scrollHeight = 1000;
      containerRef.current!.clientHeight = 500;

      renderHook(() =>
        useAutoScroll({
          containerRef,
          endRef,
          enabled: true,
          messageCount: 0,
        })
      );

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

      expect(result.current.showScrollButton).toBe(true);

      containerRef.current!.scrollTop = 400;

      vi.useFakeTimers();
      act(() => {
        resizeObserverInstances[0]?.triggerResize();
        vi.advanceTimersByTime(16);
      });
      vi.useRealTimers();

      expect(result.current.isNearBottom).toBe(true);
      expect(result.current.showScrollButton).toBe(false);
    });
  });

  describe('following by scroll position', () => {
    it('does not snap back to the bottom when a search jump ends', () => {
      const { containerRef, endRef } = createMockRefs();
      const { rerender } = renderHook(
        ({ enabled }) => useAutoScroll({ containerRef, endRef, messageCount: 5, enabled }),
        { initialProps: { enabled: true } }
      );
      rerender({ enabled: false });
      containerRef.current!.scrollTop = 200;
      rerender({ enabled: true });
      expect(containerRef.current!.scrollTop).toBe(200);
    });

    it('shows the scroll button when far from the bottom, even while paused', () => {
      const { containerRef, endRef } = createMockRefs();
      const { result } = renderHook(() =>
        useAutoScroll({ containerRef, endRef, messageCount: 0, enabled: false })
      );
      expect(result.current.showScrollButton).toBe(true);
    });

    it('keeps a scrolled-up reader in place when content reloads', () => {
      const { containerRef, endRef, addEventListenerMock } = createMockRefs();
      const { rerender } = renderHook(
        ({ messageCount }) => useAutoScroll({ containerRef, endRef, messageCount }),
        { initialProps: { messageCount: 5 } }
      );
      containerRef.current!.scrollTop = 100;
      act(() => {
        handler(addEventListenerMock, 'wheel')();
        handler(addEventListenerMock, 'scroll')();
      });
      rerender({ messageCount: 0 });
      rerender({ messageCount: 6 });
      expect(containerRef.current!.scrollTop).toBe(100);
    });

    it('keeps waiting for a scroll container that mounts late', async () => {
      vi.useFakeTimers();
      const { containerRef: mounted, endRef, addEventListenerMock } = createMockRefs();
      const containerRef = { current: null } as RefObject<HTMLDivElement>;
      renderHook(() => useAutoScroll({ containerRef, endRef, messageCount: 0 }));
      await vi.advanceTimersByTimeAsync(200);
      containerRef.current = mounted.current;
      await vi.advanceTimersByTimeAsync(50);
      expect(addEventListenerMock).toHaveBeenCalledWith('scroll', expect.any(Function), {
        passive: true,
      });
      vi.useRealTimers();
    });

    it('keeps following when layout, not the user, moves the position up', () => {
      const { containerRef, endRef, addEventListenerMock } = createMockRefs();
      renderHook(() => useAutoScroll({ containerRef, endRef, messageCount: 5 }));
      const container = containerRef.current!;
      container.scrollTop = 300;
      act(() => handler(addEventListenerMock, 'scroll')());
      act(() => {
        container.scrollHeight = 1300;
        resizeObserverInstances.at(-1)!.triggerResize();
      });
      expect(container.scrollTop).toBe(1300);
    });

    function handler(addEventListenerMock: ReturnType<typeof vi.fn>, event: string) {
      const call = addEventListenerMock.mock.calls.findLast(([type]) => type === event);
      return call?.[1] as () => void;
    }
    const scrollHandler = (mock: ReturnType<typeof vi.fn>) => handler(mock, 'scroll');

    it('stops following when the user scrolls up a little, and resumes at the bottom', () => {
      const { containerRef, endRef, addEventListenerMock } = createMockRefs();
      renderHook(() => useAutoScroll({ containerRef, endRef, messageCount: 5 }));
      const container = containerRef.current!;
      const grow = (height: number) =>
        act(() => {
          container.scrollHeight = height;
          resizeObserverInstances.at(-1)!.triggerResize();
        });

      grow(1200);
      expect(container.scrollTop).toBe(1200);

      container.scrollTop = 1200 - 500 - 50;
      act(() => {
        handler(addEventListenerMock, 'wheel')();
        scrollHandler(addEventListenerMock)();
      });
      grow(1400);
      expect(container.scrollTop).toBe(650);

      container.scrollTop = 1400 - 500;
      act(() => scrollHandler(addEventListenerMock)());
      grow(1600);
      expect(container.scrollTop).toBe(1600);
    });
  });
});

describe('followAfterScroll', () => {
  it('drops following on any upward scroll that leaves the bottom', () => {
    expect(followAfterScroll(true, true, 50, 200)).toBe(false);
    expect(followAfterScroll(true, true, 0, 200)).toBe(true);
  });

  it('resumes following near the bottom and keeps it while content grows', () => {
    expect(followAfterScroll(false, false, 150, 200)).toBe(true);
    expect(followAfterScroll(true, false, 900, 200)).toBe(true);
    expect(followAfterScroll(false, false, 900, 200)).toBe(false);
  });
});

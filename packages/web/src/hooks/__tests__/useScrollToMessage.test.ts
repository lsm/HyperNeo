// @ts-nocheck

import { renderHook, act } from '@testing-library/preact';
import type { RefObject } from 'preact';
import { useScrollToMessage } from '../useScrollToMessage.ts';

const HIGHLIGHT_CLASS = 'ring-amber-400/70';

function createTargetEl(id: string) {
  const scrollIntoViewMock = vi.fn();
  const classes = new Set<string>();
  const addMock = vi.fn((...names: string[]) => {
    for (const n of names) classes.add(n);
  });
  const removeMock = vi.fn((...names: string[]) => {
    for (const n of names) classes.delete(n);
  });
  const classList = {
    _set: classes,
    add: addMock,
    remove: removeMock,
    contains(name: string) {
      return this._set.has(name);
    },
  };
  const el = {
    scrollIntoView: scrollIntoViewMock,
    classList,
    dataset: { messageId: id },
  } as unknown as HTMLElement;
  return { el, scrollIntoViewMock, classList, addMock, removeMock };
}

function createContainer(target: HTMLElement | null | (() => HTMLElement | null)) {
  const getTarget = typeof target === 'function' ? target : () => target;
  const querySelector = vi.fn((sel: string) => {
    return getTarget();
  });
  const container = {
    querySelector,
  } as unknown as HTMLElement;
  return {
    ref: { current: container } as RefObject<HTMLElement>,
    querySelector,
  };
}

describe('useScrollToMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('scrolls target into view and applies highlight classes', () => {
    const { el, scrollIntoViewMock, classList } = createTargetEl('msg-1');
    const { ref } = createContainer(el);

    renderHook(() =>
      useScrollToMessage({
        containerRef: ref,
        messageId: 'msg-1',
        messageCount: 3,
        isInitialLoad: false,
      })
    );

    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
    expect(classList.contains(HIGHLIGHT_CLASS)).toBe(true);
  });

  it('does not scroll while isInitialLoad=true, then fires once it flips false', () => {
    const { el, scrollIntoViewMock } = createTargetEl('msg-1');
    const { ref } = createContainer(el);

    const { rerender } = renderHook(
      ({ isInitialLoad }) =>
        useScrollToMessage({
          containerRef: ref,
          messageId: 'msg-1',
          messageCount: 3,
          isInitialLoad,
        }),
      { initialProps: { isInitialLoad: true } }
    );

    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    rerender({ isInitialLoad: false });
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
  });

  it('does nothing when messageId is empty/undefined', () => {
    const { el, scrollIntoViewMock } = createTargetEl('msg-1');
    const { ref } = createContainer(el);

    renderHook(() =>
      useScrollToMessage({
        containerRef: ref,
        messageId: undefined,
        messageCount: 3,
        isInitialLoad: false,
      })
    );

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it('removes the highlight ring after the configured duration', () => {
    const { el, classList } = createTargetEl('msg-1');
    const { ref } = createContainer(el);

    renderHook(() =>
      useScrollToMessage({
        containerRef: ref,
        messageId: 'msg-1',
        messageCount: 3,
        isInitialLoad: false,
        highlightDurationMs: 5000,
      })
    );

    expect(classList.contains(HIGHLIGHT_CLASS)).toBe(true);

    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(classList.contains(HIGHLIGHT_CLASS)).toBe(true);

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });

  it('re-anchors during settling window to absorb layout shifts', () => {
    const { el, scrollIntoViewMock } = createTargetEl('msg-1');
    const { ref } = createContainer(el);

    renderHook(() =>
      useScrollToMessage({
        containerRef: ref,
        messageId: 'msg-1',
        messageCount: 3,
        isInitialLoad: false,
        settleWindowMs: 250,
      })
    );

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(3);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(4);
  });

  it('does not re-anchor after the settling window ends', () => {
    const { el, scrollIntoViewMock } = createTargetEl('msg-1');
    const { ref } = createContainer(el);

    renderHook(() =>
      useScrollToMessage({
        containerRef: ref,
        messageId: 'msg-1',
        messageCount: 3,
        isInitialLoad: false,
        settleWindowMs: 250,
      })
    );

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    const callsAtT2s = scrollIntoViewMock.mock.calls.length;

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(scrollIntoViewMock.mock.calls.length).toBe(callsAtT2s);
  });

  it('cleans up highlight + timers on unmount', () => {
    const { el, classList } = createTargetEl('msg-1');
    const { ref } = createContainer(el);

    const { unmount } = renderHook(() =>
      useScrollToMessage({
        containerRef: ref,
        messageId: 'msg-1',
        messageCount: 3,
        isInitialLoad: false,
        highlightDurationMs: 5000,
      })
    );

    expect(classList.contains(HIGHLIGHT_CLASS)).toBe(true);

    unmount();

    expect(classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });

  it('re-runs on messageCount changes until a late-rendered target is found', () => {
    const { el, scrollIntoViewMock } = createTargetEl('msg-1');
    let target: HTMLElement | null = null;
    const { ref } = createContainer(() => target);

    const { rerender } = renderHook(
      ({ messageCount }) =>
        useScrollToMessage({
          containerRef: ref,
          messageId: 'msg-1',
          messageCount,
          isInitialLoad: false,
        }),
      { initialProps: { messageCount: 3 } }
    );

    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    target = el;
    rerender({ messageCount: 4 });

    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
  });

  it('does not re-anchor or re-highlight appended messages after a successful anchor', () => {
    const { el, scrollIntoViewMock, classList, addMock } = createTargetEl('msg-1');
    const { ref } = createContainer(el);

    const { rerender } = renderHook(
      ({ messageCount }) =>
        useScrollToMessage({
          containerRef: ref,
          messageId: 'msg-1',
          messageCount,
          isInitialLoad: false,
          highlightDurationMs: 5000,
        }),
      { initialProps: { messageCount: 3 } }
    );

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    expect(classList.contains(HIGHLIGHT_CLASS)).toBe(true);

    act(() => {
      vi.advanceTimersByTime(5001);
    });
    expect(classList.contains(HIGHLIGHT_CLASS)).toBe(false);

    const scrollCallsAfterFade = scrollIntoViewMock.mock.calls.length;
    const highlightCallsAfterFade = addMock.mock.calls.length;

    rerender({ messageCount: 4 });

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(scrollCallsAfterFade);
    expect(addMock).toHaveBeenCalledTimes(highlightCallsAfterFade);
    expect(classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });

  it('calls onAnchored once when the target is first found', () => {
    const { el } = createTargetEl('msg-1');
    const onAnchored = vi.fn();
    const { ref } = createContainer(el);

    const { rerender } = renderHook(
      ({ messageCount }) =>
        useScrollToMessage({
          containerRef: ref,
          messageId: 'msg-1',
          messageCount,
          isInitialLoad: false,
          onAnchored,
        }),
      { initialProps: { messageCount: 3 } }
    );

    rerender({ messageCount: 4 });

    expect(onAnchored).toHaveBeenCalledTimes(1);
    expect(onAnchored).toHaveBeenCalledWith('msg-1');
  });

  it('does not throw when target is missing from the DOM', () => {
    const { ref } = createContainer(null);

    expect(() =>
      renderHook(() =>
        useScrollToMessage({
          containerRef: ref,
          messageId: 'no-such-id',
          messageCount: 3,
          isInitialLoad: false,
        })
      )
    ).not.toThrow();
  });
});

// @ts-nocheck

import { renderHook } from '@testing-library/preact';
import type { RefObject } from 'preact';
import { useClickOutside } from '../useClickOutside.ts';

function createMockRef(element: Partial<HTMLElement> | null = {}): RefObject<HTMLElement> {
  if (element === null) {
    return { current: null };
  }

  const mockElement = {
    contains: vi.fn((_node: Node) => false),
    ...element,
  } as unknown as HTMLElement;

  return { current: mockElement };
}

function simulateClick(target: Node) {
  const event = new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, 'target', { value: target });
  document.dispatchEvent(event);
}

function simulateKeydown(key: string) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
}

describe('useClickOutside', () => {
  let originalSetTimeout: typeof setTimeout;
  let timeoutCallbacks: Array<() => void>;

  beforeEach(() => {
    timeoutCallbacks = [];
    originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void, _delay?: number) => {
      timeoutCallbacks.push(callback);
      return timeoutCallbacks.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
  });

  function flushTimeouts() {
    timeoutCallbacks.forEach((cb) => cb());
    timeoutCallbacks = [];
  }

  describe('click outside detection', () => {
    it('should call handler when clicking outside the element', () => {
      const handler = vi.fn(() => {});
      const ref = createMockRef({
        contains: vi.fn(() => false),
      });

      renderHook(() => useClickOutside(ref, handler, true));

      flushTimeouts();

      const outsideElement = document.createElement('div');
      simulateClick(outsideElement);

      expect(handler).toHaveBeenCalled();
    });

    it('should not call handler when clicking inside the element', () => {
      const handler = vi.fn(() => {});
      const insideElement = document.createElement('div');

      const ref = createMockRef({
        contains: vi.fn((node) => node === insideElement),
      });

      renderHook(() => useClickOutside(ref, handler, true));

      flushTimeouts();

      simulateClick(insideElement);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not call handler when disabled', () => {
      const handler = vi.fn(() => {});
      const ref = createMockRef({
        contains: vi.fn(() => false),
      });

      renderHook(() => useClickOutside(ref, handler, false));

      flushTimeouts();

      const outsideElement = document.createElement('div');
      simulateClick(outsideElement);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('escape key handling', () => {
    it('should call handler when pressing Escape', () => {
      const handler = vi.fn(() => {});
      const ref = createMockRef();

      renderHook(() => useClickOutside(ref, handler, true));

      flushTimeouts();

      simulateKeydown('Escape');

      expect(handler).toHaveBeenCalled();
    });

    it('should not call handler for other keys', () => {
      const handler = vi.fn(() => {});
      const ref = createMockRef();

      renderHook(() => useClickOutside(ref, handler, true));

      flushTimeouts();

      simulateKeydown('Enter');
      simulateKeydown('Tab');
      simulateKeydown('Space');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('excluded refs', () => {
    it('should not call handler when clicking inside excluded ref', () => {
      const handler = vi.fn(() => {});
      const excludedElement = document.createElement('div');

      const mainRef = createMockRef({
        contains: vi.fn(() => false),
      });

      const excludedRef = createMockRef({
        contains: vi.fn((node) => node === excludedElement),
      });

      renderHook(() => useClickOutside(mainRef, handler, true, [excludedRef]));

      flushTimeouts();

      simulateClick(excludedElement);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle multiple excluded refs', () => {
      const handler = vi.fn(() => {});
      const excluded1 = document.createElement('div');
      const excluded2 = document.createElement('div');

      const mainRef = createMockRef({
        contains: vi.fn(() => false),
      });

      const excludedRef1 = createMockRef({
        contains: vi.fn((node) => node === excluded1),
      });

      const excludedRef2 = createMockRef({
        contains: vi.fn((node) => node === excluded2),
      });

      renderHook(() => useClickOutside(mainRef, handler, true, [excludedRef1, excludedRef2]));

      flushTimeouts();

      simulateClick(excluded1);
      expect(handler).not.toHaveBeenCalled();

      simulateClick(excluded2);
      expect(handler).not.toHaveBeenCalled();

      const outsideElement = document.createElement('div');
      simulateClick(outsideElement);
      expect(handler).toHaveBeenCalled();
    });

    it('should handle null excluded refs', () => {
      const handler = vi.fn(() => {});

      const mainRef = createMockRef({
        contains: vi.fn(() => false),
      });

      const nullExcludedRef = { current: null } as RefObject<HTMLElement>;

      renderHook(() => useClickOutside(mainRef, handler, true, [nullExcludedRef]));

      flushTimeouts();

      const outsideElement = document.createElement('div');
      simulateClick(outsideElement);

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('null ref handling', () => {
    it('should handle null main ref gracefully', () => {
      const handler = vi.fn(() => {});
      const nullRef = { current: null } as RefObject<HTMLElement>;

      renderHook(() => useClickOutside(nullRef, handler, true));

      flushTimeouts();

      const outsideElement = document.createElement('div');
      simulateClick(outsideElement);

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('should remove event listeners on unmount', () => {
      const handler = vi.fn(() => {});
      const ref = createMockRef();

      const removeEventListenerSpy = vi.fn(() => {});
      const originalRemoveEventListener = document.removeEventListener;
      document.removeEventListener = removeEventListenerSpy;

      const { unmount } = renderHook(() => useClickOutside(ref, handler, true));

      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalled();

      document.removeEventListener = originalRemoveEventListener;
    });

    it('should remove event listeners when disabled changes', () => {
      const handler = vi.fn(() => {});
      const ref = createMockRef();

      const removeEventListenerSpy = vi.fn(() => {});
      const originalRemoveEventListener = document.removeEventListener;
      document.removeEventListener = removeEventListenerSpy;

      const { rerender } = renderHook(({ enabled }) => useClickOutside(ref, handler, enabled), {
        initialProps: { enabled: true },
      });

      flushTimeouts();

      rerender({ enabled: false });

      expect(removeEventListenerSpy).toHaveBeenCalled();

      document.removeEventListener = originalRemoveEventListener;
    });
  });

  describe('delayed activation', () => {
    it('should delay adding listeners to avoid triggering from opening click', () => {
      const handler = vi.fn(() => {});
      const ref = createMockRef({
        contains: vi.fn(() => false),
      });

      renderHook(() => useClickOutside(ref, handler, true));

      const outsideElement = document.createElement('div');
      simulateClick(outsideElement);
      expect(handler).not.toHaveBeenCalled();

      flushTimeouts();
      simulateClick(outsideElement);
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('enabled toggle', () => {
    it('should start listening when enabled changes from false to true', () => {
      const handler = vi.fn(() => {});
      const ref = createMockRef({
        contains: vi.fn(() => false),
      });

      const { rerender } = renderHook(({ enabled }) => useClickOutside(ref, handler, enabled), {
        initialProps: { enabled: false },
      });

      flushTimeouts();
      const outsideElement = document.createElement('div');
      simulateClick(outsideElement);
      expect(handler).not.toHaveBeenCalled();

      rerender({ enabled: true });
      flushTimeouts();

      simulateClick(outsideElement);
      expect(handler).toHaveBeenCalled();
    });
  });
});

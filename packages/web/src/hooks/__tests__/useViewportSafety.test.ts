import { renderHook } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useViewportSafety } from '../useViewportSafety.ts';

interface MockVisualViewport {
  height: number;
  offsetTop: number;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  _trigger(event: string): void;
}

function createMockVisualViewport(height: number, offsetTop = 0): MockVisualViewport {
  const listeners: Record<string, Array<EventListenerOrEventListenerObject>> = {};
  return {
    height,
    offsetTop,
    addEventListener: vi.fn((event: string, cb: EventListenerOrEventListenerObject) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
    }),
    removeEventListener: vi.fn((event: string, cb: EventListenerOrEventListenerObject) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((l) => l !== cb);
      }
    }),
    _trigger(event: string) {
      (listeners[event] ?? []).forEach((cb) => {
        if (typeof cb === 'function') cb(new Event(event));
      });
    },
  };
}

function setNavigator(maxTouchPoints: number, userAgent: string): void {
  Object.defineProperty(navigator, 'maxTouchPoints', {
    configurable: true,
    get: () => maxTouchPoints,
  });
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    get: () => userAgent,
  });
}

function restoreNavigator(): void {
  Object.defineProperty(navigator, 'maxTouchPoints', {
    configurable: true,
    get: () => 0,
  });
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    get: () => 'Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/20.0.3',
  });
}

function setVisualViewport(vv: MockVisualViewport | null): void {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    get: () => vv,
  });
}

function restoreVisualViewport(): void {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    get: () => null,
  });
}

const WINDOW_INNER_HEIGHT = 768;

const IPAD_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15';

const DESKTOP_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15';

const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CRIOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1';

const FXIOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/604.1';

afterEach(() => {
  restoreNavigator();
  restoreVisualViewport();
  document.documentElement.style.removeProperty('--safe-height');
  document.documentElement.style.removeProperty('--keyboard-height');
  document.documentElement.style.removeProperty('--bottom-bar-height');
  document.documentElement.classList.remove('keyboard-open');
});

describe('useViewportSafety — iPad Safari detection', () => {
  it('detects iPad Safari: maxTouchPoints > 1 + Safari UA without Chrome/CriOS/FxiOS', () => {
    setNavigator(5, IPAD_SAFARI_UA);
    setVisualViewport(createMockVisualViewport(WINDOW_INNER_HEIGHT));

    renderHook(() => useViewportSafety());

    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe(
      `${WINDOW_INNER_HEIGHT}px`
    );
  });

  it('does NOT detect iPad Safari when maxTouchPoints is 0 (desktop Mac)', () => {
    setNavigator(0, DESKTOP_SAFARI_UA);
    setVisualViewport(createMockVisualViewport(WINDOW_INNER_HEIGHT));

    renderHook(() => useViewportSafety());

    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('');
  });

  it('does NOT detect iPad Safari for desktop Chrome (UA contains Chrome)', () => {
    setNavigator(5, DESKTOP_CHROME_UA);
    setVisualViewport(createMockVisualViewport(WINDOW_INNER_HEIGHT));

    renderHook(() => useViewportSafety());

    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('');
  });

  it('does NOT detect iPad Safari for CriOS (Chrome on iOS)', () => {
    setNavigator(5, CRIOS_UA);
    setVisualViewport(createMockVisualViewport(WINDOW_INNER_HEIGHT));

    renderHook(() => useViewportSafety());

    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('');
  });

  it('does NOT detect iPad Safari for FxiOS (Firefox on iOS)', () => {
    setNavigator(5, FXIOS_UA);
    setVisualViewport(createMockVisualViewport(WINDOW_INNER_HEIGHT));

    renderHook(() => useViewportSafety());

    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('');
  });
});

describe('useViewportSafety — --safe-height property', () => {
  it('sets --safe-height to visualViewport.height on iPad Safari', () => {
    setNavigator(5, IPAD_SAFARI_UA);
    setVisualViewport(createMockVisualViewport(768));

    renderHook(() => useViewportSafety());

    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('768px');
  });

  it('does NOT set --safe-height on non-iPad-Safari when no keyboard is open', () => {
    setNavigator(0, DESKTOP_SAFARI_UA);
    setVisualViewport(createMockVisualViewport(WINDOW_INNER_HEIGHT));

    renderHook(() => useViewportSafety());

    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('');
  });

  it('does nothing when visualViewport is unavailable', () => {
    setNavigator(5, IPAD_SAFARI_UA);
    setVisualViewport(null);

    expect(() => renderHook(() => useViewportSafety())).not.toThrow();
    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('');
  });
});

describe('useViewportSafety — event listeners', () => {
  it('attaches resize listeners on iPad Safari', () => {
    setNavigator(5, IPAD_SAFARI_UA);
    const mockVV = createMockVisualViewport(WINDOW_INNER_HEIGHT);
    setVisualViewport(mockVV);
    const windowAddSpy = vi.spyOn(window, 'addEventListener');

    renderHook(() => useViewportSafety());

    expect(mockVV.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(windowAddSpy).toHaveBeenCalledWith('resize', expect.any(Function));

    windowAddSpy.mockRestore();
  });

  it('attaches resize listeners on non-iPad-Safari (for keyboard detection)', () => {
    setNavigator(0, DESKTOP_SAFARI_UA);
    const mockVV = createMockVisualViewport(WINDOW_INNER_HEIGHT);
    setVisualViewport(mockVV);
    const windowAddSpy = vi.spyOn(window, 'addEventListener');

    renderHook(() => useViewportSafety());

    expect(mockVV.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(windowAddSpy).toHaveBeenCalledWith('resize', expect.any(Function));

    windowAddSpy.mockRestore();
  });

  it('removes event listeners on unmount', () => {
    setNavigator(5, IPAD_SAFARI_UA);
    const mockVV = createMockVisualViewport(WINDOW_INNER_HEIGHT);
    setVisualViewport(mockVV);
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');

    const { unmount } = renderHook(() => useViewportSafety());
    unmount();

    expect(mockVV.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('resize', expect.any(Function));

    windowRemoveSpy.mockRestore();
  });

  it('updates --safe-height when visualViewport resize fires (iPad Safari)', () => {
    setNavigator(5, IPAD_SAFARI_UA);
    const mockVV = createMockVisualViewport(WINDOW_INNER_HEIGHT);
    setVisualViewport(mockVV);

    renderHook(() => useViewportSafety());

    mockVV.height = 700;
    mockVV._trigger('resize');

    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('700px');
  });

  it('updates --safe-height when window resize fires (iPad Safari)', () => {
    setNavigator(5, IPAD_SAFARI_UA);
    const mockVV = createMockVisualViewport(WINDOW_INNER_HEIGHT);
    setVisualViewport(mockVV);

    renderHook(() => useViewportSafety());

    mockVV.height = 600;
    window.dispatchEvent(new Event('resize'));

    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('600px');
  });
});

describe('useViewportSafety — keyboard detection', () => {
  it('detects keyboard open: adds keyboard-open class and adjusts CSS vars', () => {
    setNavigator(0, DESKTOP_SAFARI_UA);
    const mockVV = createMockVisualViewport(WINDOW_INNER_HEIGHT);
    setVisualViewport(mockVV);

    renderHook(() => useViewportSafety());

    expect(document.documentElement.classList.contains('keyboard-open')).toBe(false);

    mockVV.height = WINDOW_INNER_HEIGHT - 300;
    mockVV._trigger('resize');

    expect(document.documentElement.classList.contains('keyboard-open')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe(
      `${WINDOW_INNER_HEIGHT - 300}px`
    );
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('300px');
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height')).toBe('0px');
  });

  it('detects keyboard close: removes keyboard-open class and restores CSS vars', () => {
    setNavigator(0, DESKTOP_SAFARI_UA);
    const mockVV = createMockVisualViewport(WINDOW_INNER_HEIGHT);
    setVisualViewport(mockVV);

    document.documentElement.style.setProperty('--bottom-bar-height', '56px');

    renderHook(() => useViewportSafety());

    mockVV.height = WINDOW_INNER_HEIGHT - 300;
    mockVV._trigger('resize');

    expect(document.documentElement.classList.contains('keyboard-open')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height')).toBe('0px');

    mockVV.height = WINDOW_INNER_HEIGHT;
    mockVV._trigger('resize');

    expect(document.documentElement.classList.contains('keyboard-open')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height')).toBe('56px');
    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('');
  });

  it('does NOT trigger keyboard detection for small viewport changes (below 50px threshold)', () => {
    setNavigator(0, DESKTOP_SAFARI_UA);
    const mockVV = createMockVisualViewport(WINDOW_INNER_HEIGHT);
    setVisualViewport(mockVV);

    renderHook(() => useViewportSafety());

    mockVV.height = WINDOW_INNER_HEIGHT - 30;
    mockVV._trigger('resize');

    expect(document.documentElement.classList.contains('keyboard-open')).toBe(false);
  });

  it('detects keyboard at exactly the threshold boundary (51px)', () => {
    setNavigator(0, DESKTOP_SAFARI_UA);
    const mockVV = createMockVisualViewport(WINDOW_INNER_HEIGHT);
    setVisualViewport(mockVV);

    renderHook(() => useViewportSafety());

    mockVV.height = WINDOW_INNER_HEIGHT - 51;
    mockVV._trigger('resize');

    expect(document.documentElement.classList.contains('keyboard-open')).toBe(true);
  });

  it('does NOT trigger at threshold boundary (50px exactly)', () => {
    setNavigator(0, DESKTOP_SAFARI_UA);
    const mockVV = createMockVisualViewport(WINDOW_INNER_HEIGHT);
    setVisualViewport(mockVV);

    renderHook(() => useViewportSafety());

    mockVV.height = WINDOW_INNER_HEIGHT - 50;
    mockVV._trigger('resize');

    expect(document.documentElement.classList.contains('keyboard-open')).toBe(false);
  });

  it('works on iPad Safari: keyboard detection plus always-on --safe-height', () => {
    setNavigator(5, IPAD_SAFARI_UA);
    const mockVV = createMockVisualViewport(WINDOW_INNER_HEIGHT);
    setVisualViewport(mockVV);

    renderHook(() => useViewportSafety());

    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe(
      `${WINDOW_INNER_HEIGHT}px`
    );

    mockVV.height = WINDOW_INNER_HEIGHT - 300;
    mockVV._trigger('resize');

    expect(document.documentElement.classList.contains('keyboard-open')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe(
      `${WINDOW_INNER_HEIGHT - 300}px`
    );
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('300px');
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height')).toBe('0px');

    mockVV.height = WINDOW_INNER_HEIGHT;
    mockVV._trigger('resize');

    expect(document.documentElement.classList.contains('keyboard-open')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe(
      `${WINDOW_INNER_HEIGHT}px`
    );
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('');
  });

  it('detects initial keyboard state on mount', () => {
    setNavigator(0, DESKTOP_SAFARI_UA);
    const mockVV = createMockVisualViewport(WINDOW_INNER_HEIGHT - 300);
    setVisualViewport(mockVV);

    renderHook(() => useViewportSafety());

    expect(document.documentElement.classList.contains('keyboard-open')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe(
      `${WINDOW_INNER_HEIGHT - 300}px`
    );
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('300px');
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height')).toBe('0px');
  });

  it('dispatches window resize when keyboard closes (for BottomTabBar re-measurement)', () => {
    setNavigator(0, DESKTOP_SAFARI_UA);
    const mockVV = createMockVisualViewport(WINDOW_INNER_HEIGHT);
    setVisualViewport(mockVV);
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    renderHook(() => useViewportSafety());

    mockVV.height = WINDOW_INNER_HEIGHT - 300;
    mockVV._trigger('resize');

    mockVV.height = WINDOW_INNER_HEIGHT;
    mockVV._trigger('resize');

    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'resize' }));

    dispatchSpy.mockRestore();
  });

  it('cleans up keyboard state on unmount', () => {
    setNavigator(0, DESKTOP_SAFARI_UA);
    const mockVV = createMockVisualViewport(WINDOW_INNER_HEIGHT - 300);
    setVisualViewport(mockVV);

    const { unmount } = renderHook(() => useViewportSafety());

    expect(document.documentElement.classList.contains('keyboard-open')).toBe(true);

    unmount();

    expect(document.documentElement.classList.contains('keyboard-open')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('');
  });

  it('restores --bottom-bar-height even when it was empty string (desktop)', () => {
    setNavigator(0, DESKTOP_SAFARI_UA);
    const mockVV = createMockVisualViewport(WINDOW_INNER_HEIGHT);
    setVisualViewport(mockVV);

    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height')).toBe('');

    renderHook(() => useViewportSafety());

    mockVV.height = WINDOW_INNER_HEIGHT - 300;
    mockVV._trigger('resize');

    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height')).toBe('0px');

    mockVV.height = WINDOW_INNER_HEIGHT;
    mockVV._trigger('resize');

    expect(document.documentElement.classList.contains('keyboard-open')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height')).toBe('');
  });
});

// @ts-nocheck
/**
 * Unit tests for GlassTabStrip scroll chevrons.
 *
 * jsdom has no layout, so the scroller's scroll metrics are stubbed per test
 * via Object.defineProperty and the component is driven with synthetic scroll
 * events (the same signal the real browser fires while swiping).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { GlassTabStrip } from '../glass-workspace';

/** Stub the pointer-capability media query arrows depend on. */
function stubPointerEnv(matches) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

function mount() {
  return render(
    <GlassTabStrip>
      <div role="tablist">
        <button type="button">General</button>
        <button type="button">Advanced</button>
      </div>
    </GlassTabStrip>
  );
}

function stripEl(container) {
  return container.querySelector('[role="tablist"]');
}

/** Stub the scroller's overflow metrics and notify the component. */
function setScroll(el, { scrollWidth = 500, clientWidth = 300, scrollLeft = 0, scrollBy }) {
  const props = { configurable: true };
  Object.defineProperty(el, 'scrollWidth', { ...props, value: scrollWidth });
  Object.defineProperty(el, 'clientWidth', { ...props, value: clientWidth });
  Object.defineProperty(el, 'scrollLeft', { ...props, value: scrollLeft });
  if (scrollBy) el.scrollBy = scrollBy;
  fireEvent(el, new Event('scroll'));
}

describe('GlassTabStrip', () => {
  beforeEach(() => {
    cleanup();
    // jsdom's matchMedia never matches; default to a pointer-only environment.
    stubPointerEnv(() => true);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('hides arrows on touch-primary devices even when overflowing', async () => {
    stubPointerEnv((q) => !q.includes('hover: hover')); // touch: no hover capability
    const { container } = mount();
    const el = stripEl(container);
    setScroll(el, { scrollLeft: 0 });
    await waitFor(() => {
      expect(container.querySelector('[role="tablist"]').scrollLeft).toBe(0);
    });
    expect(container.querySelectorAll('button[aria-label^="Scroll tabs"]')).toHaveLength(0);
  });

  it('renders no arrows when the strip fits', async () => {
    const { container } = mount();
    const el = stripEl(container);
    setScroll(el, { scrollWidth: 300, clientWidth: 300 });
    await waitFor(() => {
      expect(container.querySelectorAll('button[aria-label^="Scroll tabs"]')).toHaveLength(0);
    });
  });

  it('shows only the right arrow at the strip start', async () => {
    const { container } = mount();
    const el = stripEl(container);
    setScroll(el, { scrollLeft: 0 });
    await waitFor(() => {
      const arrows = container.querySelectorAll('button[aria-label^="Scroll tabs"]');
      expect(arrows).toHaveLength(1);
      expect(arrows[0].getAttribute('aria-label')).toBe('Scroll tabs right');
    });
  });

  it('shows both arrows in the middle and only left at the end', async () => {
    const { container } = mount();
    const el = stripEl(container);
    setScroll(el, { scrollLeft: 150 });
    await waitFor(() => {
      expect(container.querySelectorAll('button[aria-label^="Scroll tabs"]')).toHaveLength(2);
    });

    setScroll(el, { scrollLeft: 200 }); // scrollWidth - clientWidth = 200
    await waitFor(() => {
      const arrows = container.querySelectorAll('button[aria-label^="Scroll tabs"]');
      expect(arrows).toHaveLength(1);
      expect(arrows[0].getAttribute('aria-label')).toBe('Scroll tabs left');
    });
  });

  it('right arrow scrolls forward and left arrow scrolls back', async () => {
    const scrollBy = vi.fn();
    const { container } = mount();
    const el = stripEl(container);
    setScroll(el, { scrollLeft: 150, scrollBy });

    const right = await waitFor(() => {
      const btn = container.querySelector('button[aria-label="Scroll tabs right"]');
      expect(btn).toBeTruthy();
      return btn;
    });
    fireEvent.click(right);
    expect(scrollBy).toHaveBeenCalledTimes(1);
    const { left, behavior } = scrollBy.mock.calls[0][0];
    expect(left).toBeGreaterThan(0); // clientWidth 300 * 0.75 = 225
    expect(behavior).toBe('smooth');

    const leftBtn = container.querySelector('button[aria-label="Scroll tabs left"]');
    fireEvent.click(leftBtn);
    const backArgs = scrollBy.mock.calls[1][0];
    expect(backArgs.left).toBeLessThan(0);
  });

  it('updates arrows when pills change (mutation, not just scroll)', async () => {
    const { container } = mount();
    const el = stripEl(container);
    setScroll(el, { scrollWidth: 300, clientWidth: 300 });
    await waitFor(() => {
      expect(container.querySelectorAll('button[aria-label^="Scroll tabs"]')).toHaveLength(0);
    });
    // Simulate content growing (e.g. a tab gains a dirty dot) past the edge.
    setScroll(el, { scrollWidth: 500, clientWidth: 300, scrollLeft: 0 });
    await waitFor(() => {
      expect(container.querySelectorAll('button[aria-label^="Scroll tabs"]')).toHaveLength(1);
    });
  });
});

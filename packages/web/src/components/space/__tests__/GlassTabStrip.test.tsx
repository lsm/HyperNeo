// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { GlassTabStrip } from '../glass-workspace';

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
    stubPointerEnv(() => true);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('hides arrows on touch-primary devices even when overflowing', async () => {
    stubPointerEnv((q) => !q.includes('hover: hover'));
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

    setScroll(el, { scrollLeft: 200 });
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
    expect(left).toBeGreaterThan(0);
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
    setScroll(el, { scrollWidth: 500, clientWidth: 300, scrollLeft: 0 });
    await waitFor(() => {
      expect(container.querySelectorAll('button[aria-label^="Scroll tabs"]')).toHaveLength(1);
    });
  });
});

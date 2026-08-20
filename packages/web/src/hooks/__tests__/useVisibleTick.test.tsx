import { cleanup, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useVisibleTick } from '../useVisibleTick.ts';

function setHidden(value: boolean) {
  Object.defineProperty(document, 'hidden', { value, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

let renders = 0;
function Harness({
  intervalMs,
  enabled,
  onTick,
}: {
  intervalMs: number;
  enabled?: boolean;
  onTick?: () => void;
}) {
  renders++;
  useVisibleTick(intervalMs, enabled, onTick);
  return null;
}

describe('useVisibleTick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    renders = 0;
    setHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('re-renders on each interval while visible', async () => {
    render(<Harness intervalMs={1000} />);
    expect(renders).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(renders).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(renders).toBe(4);
  });

  it('does not tick when mounted while hidden', async () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    render(<Harness intervalMs={1000} />);
    await vi.advanceTimersByTimeAsync(5000);
    expect(renders).toBe(1);
  });

  it('stops ticking while hidden and resumes with an immediate tick on visible', async () => {
    render(<Harness intervalMs={1000} />);
    await vi.advanceTimersByTimeAsync(1000);
    expect(renders).toBe(2);

    setHidden(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(renders).toBe(2);

    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(renders).toBe(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(renders).toBe(4);
  });

  it('invokes onTick on the interval and on regain of visibility', async () => {
    const onTick = vi.fn();
    render(<Harness intervalMs={1000} onTick={onTick} />);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onTick).toHaveBeenCalledTimes(2);

    setHidden(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onTick).toHaveBeenCalledTimes(2);

    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(onTick).toHaveBeenCalledTimes(3);
  });

  it('does not tick while disabled', async () => {
    const { rerender } = render(<Harness intervalMs={1000} enabled={false} />);
    await vi.advanceTimersByTimeAsync(5000);
    expect(renders).toBe(1);

    rerender(<Harness intervalMs={1000} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(renders).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(renders).toBe(3);
  });

  it('drops the visibility listener on unmount', async () => {
    const onTick = vi.fn();
    const { unmount } = render(<Harness intervalMs={1000} onTick={onTick} />);
    unmount();
    setHidden(true);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onTick).not.toHaveBeenCalled();
  });
});

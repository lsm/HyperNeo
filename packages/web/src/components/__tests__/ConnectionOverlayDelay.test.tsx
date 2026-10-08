import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reconnect = vi.hoisted(() => vi.fn(async () => {}));
const conn = vi.hoisted(() => ({ state: { value: 'connected' }, attempts: { value: 0 } }));
vi.mock('../../lib/connection-manager.ts', () => ({ connectionManager: { reconnect } }));
vi.mock('../../lib/state.ts', () => ({
  connectionState: conn.state,
  reconnectAttemptCount: conn.attempts,
}));

import { ConnectionOverlay } from '../ConnectionOverlay.tsx';

describe('ConnectionOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reconnect.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    conn.state.value = 'connected';
    conn.attempts.value = 0;
  });

  it('stays hidden through a blip shorter than two seconds', () => {
    conn.state.value = 'reconnecting';
    conn.attempts.value = 1;
    const { rerender } = render(<ConnectionOverlay />);
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(screen.queryByText('Reconnecting…')).toBeNull();

    conn.state.value = 'connected';
    conn.attempts.value = 0;
    rerender(<ConnectionOverlay />);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.queryByText('Reconnecting…')).toBeNull();
  });

  it('shows after two seconds and retries now when tapped', () => {
    conn.state.value = 'reconnecting';
    conn.attempts.value = 3;
    render(<ConnectionOverlay />);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    fireEvent.click(screen.getByRole('button', { name: /Connection lost. Retrying…/ }));
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('says it is waiting for the network while offline', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      conn.state.value = 'disconnected';
      render(<ConnectionOverlay />);
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(screen.getByRole('button', { name: /Waiting for network…/ })).toBeTruthy();
      onLine.mockReturnValue(true);
      act(() => {
        window.dispatchEvent(new Event('online'));
      });
      expect(screen.getByRole('button', { name: /Connection lost. Retrying…/ })).toBeTruthy();
    } finally {
      onLine.mockRestore();
    }
  });
});

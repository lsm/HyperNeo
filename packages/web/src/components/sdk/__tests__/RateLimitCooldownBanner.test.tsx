import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/api-helpers', () => ({
  cancelRateLimitRetry: vi.fn(),
  retryNowAfterRateLimit: vi.fn(),
}));

import { RateLimitCooldownBanner } from '../RateLimitCooldownBanner';

function setHidden(value: boolean) {
  Object.defineProperty(document, 'hidden', { value, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

function countdownText(): string {
  return screen.getByText(/Auto-retry in/).textContent ?? '';
}

describe('RateLimitCooldownBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    setHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('counts down while visible', async () => {
    render(
      <RateLimitCooldownBanner sessionId="s1" retryCount={1} maxRetries={5} retryAt={15_000} />
    );
    expect(countdownText()).toContain('5s');
    await vi.advanceTimersByTimeAsync(3000);
    expect(countdownText()).toContain('2s');
  });

  it('pauses while hidden and recomputes remaining time on visible', async () => {
    render(
      <RateLimitCooldownBanner sessionId="s1" retryCount={1} maxRetries={5} retryAt={15_000} />
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(countdownText()).toContain('2s');

    setHidden(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(countdownText()).toContain('2s');

    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(countdownText()).toContain('now');
  });

  it('stops ticking once the countdown reaches zero', async () => {
    render(
      <RateLimitCooldownBanner sessionId="s1" retryCount={1} maxRetries={5} retryAt={12_000} />
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(countdownText()).toContain('now');
    await vi.advanceTimersByTimeAsync(5000);
    expect(countdownText()).toContain('now');
  });

  it('restarts the countdown when retryAt extends', async () => {
    const { rerender } = render(
      <RateLimitCooldownBanner sessionId="s1" retryCount={1} maxRetries={5} retryAt={15_000} />
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(countdownText()).toContain('now');

    rerender(
      <RateLimitCooldownBanner sessionId="s1" retryCount={2} maxRetries={5} retryAt={30_000} />
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(countdownText()).toContain('15s');
    await vi.advanceTimersByTimeAsync(1000);
    expect(countdownText()).toContain('14s');
  });
});

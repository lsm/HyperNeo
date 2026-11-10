import { effect } from '@preact/signals';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { locale } from '../../lib/i18n/index.ts';
import { NeoTime } from '../NeoTime.tsx';
import { neoNow } from '../neo-time.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  locale.value = 'en';
});

describe('NeoTime', () => {
  it('omits missing dates and supports tap, escape and outside dismissal', () => {
    const at = Date.now() - 120_000;
    const app = render(
      <>
        <NeoTime at={0} />
        <NeoTime at={at} settledAt={at + 60_000} />
      </>
    );
    expect(app.container.querySelectorAll('details')).toHaveLength(1);
    const details = app.container.querySelector('details')!;
    const summary = details.querySelector('summary')!;
    expect(summary.getAttribute('aria-label')).toContain('Created');
    expect(summary.getAttribute('aria-label')).toContain(String(new Date(at).getFullYear()));
    expect(details.textContent).toContain('Settled');
    details.open = true;
    fireEvent.keyDown(summary, { key: 'Escape' });
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);
    details.open = true;
    fireEvent.pointerDown(document.body);
    expect(details.open).toBe(false);
  });

  it('shares one visible-page timer and refreshes immediately on return', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 9, 18, 30));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const stopFirst = effect(() => {
      void neoNow.value;
    });
    const stopSecond = effect(() => {
      void neoNow.value;
    });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(neoNow.peek()).toBe(Date.now());
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(Date.now() + 180_000);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    expect(neoNow.peek()).toBe(Date.now());
    expect(vi.getTimerCount()).toBe(1);
    stopFirst();
    expect(vi.getTimerCount()).toBe(1);
    stopSecond();
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { act, cleanup, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoBusyRow } from '../NeoBusyRow.tsx';

afterEach(cleanup);

describe('NeoBusyRow', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('cycles the busy words every three seconds beside the dots', () => {
    const result = render(<NeoBusyRow words={['Neo is working…', 'Syncing…']} />);
    const row = screen.getByRole('status');
    expect(row.textContent).toBe('Neo is working…');
    expect(result.container.querySelectorAll('.neo-progress-dots i')).toHaveLength(3);
    expect(row.getAttribute('aria-live')).toBe('off');
    expect(row.getAttribute('aria-label')).toBe('Neo is working…');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(row.textContent).toBe('Syncing…');
  });
  it('holds a single word without a timer', () => {
    render(<NeoBusyRow words={['Waiting to retry…']} />);
    expect(screen.getByRole('status').textContent).toBe('Waiting to retry…');
    expect(vi.getTimerCount()).toBe(0);
  });
});

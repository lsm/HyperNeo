import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionScheduleView } from '@hyperneo/shared/types/session-schedule';
import { SessionSchedules } from '../SessionSchedules.tsx';
import { locale } from '../../lib/i18n/index.ts';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: async () => ({ request }) },
}));
const row: SessionScheduleView = {
  id: 's1',
  target: { adapter: 'hyperneo', id: 'root' },
  sourceKind: 'goal',
  sourceId: 'g1',
  sourceLabel: 'Ship guide',
  note: null,
  cadence: { kind: 'every', everyMs: 3600000 },
  nudgeEvery: 4,
  dueCount: 2,
  status: 'active',
  nextRunAt: 1792580400000,
  pendingJobId: 'job',
  factsDigest: null,
  lastRunAt: 1792576800000,
  lastOutcome: 'skipped_busy',
  lastSkipReason: 'busy',
  lastMessageId: null,
  createdBySession: 'root',
  createdAt: 1792570000000,
  updatedAt: 1792576800000,
};
let rows: SessionScheduleView[];
const originalLocale = locale.value;
beforeEach(() => {
  locale.value = 'en';
  rows = [{ ...row }];
  request.mockReset().mockImplementation(async (_method, { name, input }) => {
    if (name === 'schedule.session.list') return { ok: true, schedules: rows };
    if (name === 'goal.journal.list') return { accepted: true, entries: [] };
    if (name === 'goal.session.get')
      return {
        accepted: true,
        goal: {
          title: 'Ship guide',
          metrics: {},
          nextSteps: [],
          worksNote: null,
          mandateRef: null,
          description: 'Publish for adopters.',
          doneTest: 'Guide is public',
        },
      };
    rows = rows.map((item) =>
      item.id === input.scheduleId
        ? {
            ...item,
            status: name.endsWith('pause') ? 'paused' : 'active',
          }
        : item
    );
    return { ok: true };
  });
});
afterEach(() => {
  cleanup();
  locale.value = originalLocale;
});
async function open() {
  await screen.findByText('Ship guide');
  fireEvent.click(screen.getByRole('button', { name: 'more — Schedules' }));
}

describe('SessionSchedules', () => {
  it('reads only this session and folds cadence, next/last run, reason and quiet facts', async () => {
    const { container } = render(<SessionSchedules sessionId="root" />);
    await open();
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'schedule.session.list',
      input: { target: { adapter: 'hyperneo', id: 'root' } },
    });
    expect(container.querySelector('details')?.open).toBe(true);
    expect(screen.getByText('Every 60 min')).toBeTruthy();
    expect(screen.queryByText(/Nudge/)).toBeNull();
    expect(screen.getByText(/Skipped · Session busy/)).toBeTruthy();
    expect([...container.querySelectorAll('time')].map((time) => time.dateTime)).toEqual([
      new Date(row.nextRunAt!).toISOString(),
      new Date(row.lastRunAt!).toISOString(),
    ]);
  });
  it('is collapsed initially, pauses/resumes through the operations and re-reads the facts', async () => {
    const { container } = render(<SessionSchedules sessionId="root" />);
    await screen.findByText('Ship guide');
    expect(container.querySelector('details')?.open).toBe(false);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await screen.findByRole('button', { name: 'Resume' });
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'schedule.session.pause',
      input: { scheduleId: 's1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await screen.findByRole('button', { name: 'Pause' });
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'schedule.session.resume',
      input: { scheduleId: 's1' },
    });
  });
  it('opens the linked goal definition with its owner and done-test', async () => {
    render(<SessionSchedules sessionId="root" />);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'more — Ship guide' }));
    await screen.findByText('Guide is public');
    expect(screen.getByText('Publish for adopters.')).toBeTruthy();
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'goal.session.get',
      input: { ownerSessionId: 'root', goalId: 'g1' },
    });
  });
  it('shows cron timezone, reminder label, unknown source fallback and terminal status', async () => {
    rows = [
      {
        ...row,
        sourceKind: 'reminder',
        sourceLabel: 'Check release',
        status: 'done',
        cadence: { kind: 'cron', cron: '0 9 * * *', timezone: 'Asia/Shanghai' },
        nextRunAt: null,
        lastOutcome: 'target_gone',
        lastSkipReason: null,
      },
      { ...row, id: 's2', sourceKind: 'other', sourceLabel: null, lastRunAt: null },
    ];
    render(<SessionSchedules sessionId="root" />);
    await screen.findByText('Check release');
    fireEvent.click(screen.getByRole('button', { name: 'more — Schedules' }));
    expect(screen.getByText('0 9 * * * · Asia/Shanghai')).toBeTruthy();
    expect(screen.getByText('Source unavailable')).toBeTruthy();
    expect(screen.getByText(/Session closed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });
  it('keeps refused mutations visible and allows a fresh read without changing status', async () => {
    render(<SessionSchedules sessionId="root" />);
    await open();
    request.mockImplementation(async (_method, { name }) =>
      name === 'schedule.session.list'
        ? { ok: true, schedules: rows }
        : { ok: false, reason: 'busy: the schedule is firing; try again.' }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'busy: the schedule is firing'
    );
    expect(screen.getByRole('button', { name: 'Pause' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh schedules' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it('ignores a previous session response after navigation and refreshes on focus', async () => {
    let complete!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const { rerender } = render(<SessionSchedules sessionId="old" />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    rerender(<SessionSchedules sessionId="new" />);
    await screen.findByText('Ship guide');
    complete({ ok: true, schedules: [{ ...row, sourceLabel: 'Stale title' }] });
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(screen.queryByText('Stale title')).toBeNull();
  });
  it('does not mutate read-only sessions and handles empty and failed reads', async () => {
    const { rerender } = render(<SessionSchedules sessionId="root" readonly />);
    await open();
    expect(screen.getByRole('button', { name: 'Pause' }).hasAttribute('disabled')).toBe(true);
    rows = [];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh schedules' }));
    await screen.findByText('No schedules');
    request.mockRejectedValue(new Error('Connection lost'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh schedules' }));
    await screen.findByText('Connection lost');
    expect(screen.queryByText('No schedules')).toBeNull();
    rerender(<SessionSchedules sessionId={null} />);
    expect(screen.queryByText('Schedules')).toBeNull();
  });
  it('updates run facts on the visible refresh without replacing the disclosure', async () => {
    const hidden = document.hidden;
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    vi.useFakeTimers();
    try {
      const { container } = render(<SessionSchedules sessionId="root" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      const details = container.querySelector('details')!;
      fireEvent.click(screen.getByRole('button', { name: 'more — Schedules' }));
      rows = [{ ...row, dueCount: 0, lastOutcome: 'fired', lastSkipReason: null }];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30000);
      });
      expect(request).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
      await screen.findByText(/Delivered/);
      expect(screen.queryByText(/Nudge/)).toBeNull();
      expect(container.querySelector('details')).toBe(details);
      expect(details.open).toBe(true);
    } finally {
      vi.useRealTimers();
      Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
    }
  });
  it('shows a goal read failure without losing schedule controls', async () => {
    render(<SessionSchedules sessionId="root" />);
    await open();
    request.mockResolvedValueOnce({ accepted: false, reason: 'Goal no longer exists' });
    fireEvent.click(screen.getByRole('button', { name: 'more — Ship guide' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Goal no longer exists');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });
  it.each([4, 6])('never promises a forced turn after %s quiet wakes', async (dueCount) => {
    rows = [{ ...row, dueCount }];
    render(<SessionSchedules sessionId="root" />);
    await open();
    expect(screen.queryByText(/Nudge/)).toBeNull();
    expect(rows[0].dueCount).toBe(dueCount);
  });
  it('keeps the count unknown while loading or failed, then shows an actual empty result', async () => {
    let reject!: (error: Error) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        })
    );
    const { container } = render(<SessionSchedules sessionId="root" />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const summary = container.querySelector('summary')!;
    expect(summary.querySelector('span')?.textContent?.trim()).toBe('Schedules');
    reject(new Error('Read unavailable'));
    await screen.findByText('Read unavailable');
    expect(summary.querySelector('span')?.textContent?.trim()).toBe('Schedules');
    rows = [];
    fireEvent.click(screen.getByRole('button', { name: 'more — Schedules' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh schedules' }));
    await screen.findByText('No schedules');
    expect(summary.querySelector('span')?.textContent?.trim()).toBe('Schedules · 0');
  });
  it('localizes the visible strip and controls', async () => {
    locale.value = 'zh-Hans';
    render(<SessionSchedules sessionId="root" />);
    await screen.findByText('Ship guide');
    expect(screen.getByText('定时检查')).toBeTruthy();
    expect(screen.queryByText(/次提醒/)).toBeNull();
    expect(screen.getByRole('button', { name: '暂停', hidden: true })).toBeTruthy();
  });
});

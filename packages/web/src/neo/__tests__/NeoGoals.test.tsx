import type { SessionGoal } from '@hyperneo/shared/types/session-goal';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoGoals } from '../NeoGoals.tsx';
import { locale } from '../../lib/i18n/index.ts';
const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: async () => ({ request }) },
}));
const goal: SessionGoal = {
  id: 'guide',
  ownerSessionId: 'root',
  title: 'Publish guide',
  description: 'Public guide',
  status: 'active',
  type: 'measurable',
  priority: 'normal',
  metrics: { readers: 30 },
  doneTest: null,
  summary: '',
  worksNote: null,
  progress: 30,
  nextSteps: [],
  mandateRef: null,
  mandateRev: null,
  createdAt: 1,
  updatedAt: 2,
  completedAt: null,
  revision: 1,
};
const at = 1792605600000;
let goals: SessionGoal[];
let effect: string;
const initialLocale = locale.value;
beforeEach(() => {
  locale.value = 'en';
  goals = [
    goal,
    {
      ...goal,
      id: 'launch',
      title: 'Launch release',
      type: 'one_shot',
      status: 'paused',
      metrics: {},
      progress: 0,
      doneTest: 'Release is public',
    },
  ];
  effect = 'Reached thirty readers';
  request.mockReset().mockImplementation(async (_method, { name, input }) => {
    if (name === 'goal.session.list') return { accepted: true, goals };
    if (name === 'goal.session.get')
      return { accepted: true, goal: { ...goal, worksNote: 'Concrete examples work' } };
    if (name === 'schedule.session.list')
      return {
        ok: true,
        schedules: [
          { sourceKind: 'goal', sourceId: 'guide', status: 'active', nextRunAt: at },
          { sourceKind: 'goal', sourceId: 'launch', status: 'paused', nextRunAt: null },
        ],
      };
    if (name === 'goal.journal.list')
      return {
        accepted: true,
        entries: input.limit === 1 && input.goalId === 'guide' ? [{ effect }] : [],
      };
    throw new Error(`Unexpected operation ${name}`);
  });
});
afterEach(() => {
  cleanup();
  locale.value = initialLocale;
});
describe('NeoGoals', () => {
  it('lists scoped goals with type, progress, next wake and latest effect', async () => {
    const { container } = render(<NeoGoals sessionId="root" />);
    await screen.findByText(effect);
    for (const [name, input] of [
      ['goal.session.list', { ownerSessionId: 'root', includeClosed: false }],
      ['schedule.session.list', { target: { adapter: 'hyperneo', id: 'root' } }],
      ['goal.journal.list', { ownerSessionId: 'root', goalId: 'guide', limit: 1 }],
    ])
      expect(request).toHaveBeenCalledWith('operation.invoke', { name, input });
    expect(
      screen.getByRole('progressbar', { name: 'Publish guide' }).getAttribute('aria-valuenow')
    ).toBe('30');
    for (const text of [
      'Measurable',
      'One-shot',
      'Paused',
      'Release is public',
      'No journal entries yet',
    ])
      expect(screen.getByText(text)).toBeTruthy();
    expect(container.querySelector('time')?.dateTime).toBe(new Date(at).toISOString());
  });
  it('opens the selected goal’s scoped details from its title and closes them again', async () => {
    render(<NeoGoals sessionId="root" />);
    await screen.findByText(effect);
    expect(screen.queryByText('Public guide')).toBeNull();
    const title = screen.getByRole('button', { name: 'Publish guide' });
    fireEvent.click(title);
    await screen.findByText('Concrete examples work');
    expect(screen.getByText('Public guide')).toBeTruthy();
    expect(title.getAttribute('aria-expanded')).toBe('true');
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'goal.session.get',
      input: { ownerSessionId: 'root', goalId: 'guide' },
    });
    fireEvent.click(title);
    expect(screen.queryByText('Public guide')).toBeNull();
    expect(title.getAttribute('aria-expanded')).toBe('false');
  });
  it('does not claim an empty list while loading and shows a real empty result', async () => {
    let finish!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    render(<NeoGoals sessionId="root" />);
    expect(screen.getByRole('status').textContent).toContain('Loading goals');
    expect(screen.queryByText('No goals yet')).toBeNull();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await act(async () => finish({ accepted: true, goals: [] }));
    await screen.findByText('No goals yet');
    expect(request.mock.calls.filter(([, data]) => data.name === 'goal.journal.list')).toHaveLength(
      0
    );
  });
  it('reports a failed list and retries', async () => {
    request.mockRejectedValueOnce(new Error('Goals unavailable'));
    render(<NeoGoals sessionId="root" />);
    expect((await screen.findByRole('alert')).textContent).toContain('Goals unavailable');
    expect(screen.queryByText('No goals yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh goals' }));
    await screen.findByText(effect);
  });
  it('reports a journal refusal rather than inventing no latest effect', async () => {
    request.mockImplementation(async (_method, { name }) => {
      if (name === 'goal.session.list') return { accepted: true, goals: [goal] };
      if (name === 'schedule.session.list') return { ok: true, schedules: [] };
      return { accepted: false, reason: 'Journal unavailable' };
    });
    render(<NeoGoals sessionId="root" />);
    await screen.findByText('Journal unavailable');
    expect(screen.queryByText('No journal entries yet')).toBeNull();
  });
  it('refreshes recorded facts after focus', async () => {
    render(<NeoGoals sessionId="root" />);
    await screen.findByText(effect);
    effect = 'Fifty readers now';
    fireEvent(window, new Event('focus'));
    await screen.findByText(effect);
    expect(screen.queryByText('Reached thirty readers')).toBeNull();
  });
  it('discards a stale owner read after switching sessions', async () => {
    let finish!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const { rerender } = render(<NeoGoals sessionId="old" />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    rerender(<NeoGoals sessionId="new" />);
    await screen.findByText(effect);
    await act(async () =>
      finish({ accepted: true, goals: [{ ...goal, title: 'Old private goal' }] })
    );
    expect(screen.queryByText('Old private goal')).toBeNull();
  });
  it('localizes the list and no-wake state', async () => {
    locale.value = 'zh-Hans';
    render(<NeoGoals sessionId="root" />);
    const region = await screen.findByRole('region', { name: '目标' });
    await within(region).findByText('可衡量');
    for (const text of ['一次性', '已暂停', '暂无唤醒'])
      expect(within(region).getByText(text)).toBeTruthy();
  });
  it('does not read for an unopened session', async () => {
    const { container } = render(<NeoGoals sessionId={null} />);
    await act(async () => {});
    expect(container.textContent).toBe('');
    expect(request).not.toHaveBeenCalled();
  });
});

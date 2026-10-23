import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalDefinition } from '../SessionSchedules.tsx';
import { locale } from '../../lib/i18n/index.ts';
const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: async () => ({ request }) },
}));
const goal = {
  id: 'guide',
  ownerSessionId: 'root',
  title: 'Publish guide',
  description: 'Guide for adopters',
  metrics: { readers: 30, useful: true },
  doneTest: 'One hundred readers',
  nextSteps: ['Write examples'],
  worksNote: 'Concrete examples work',
  mandateRef: 'mandate.md#adoption',
  mandateRev: 'abc123',
};
const entry = (id: number) => ({
  id: `entry-${id}`,
  goalId: 'guide',
  createdAt: id,
  done: `Action ${id}`,
  effect: `Effect ${id}`,
  worked: 'Repeat examples',
  failed: 'Stop filler',
  evidence: [
    { kind: 'pr', ref: 'https://github.com/example/repo/pull/1', note: 'Merged guide' },
    { kind: 'text', ref: 'javascript:alert(1)', note: 'Plain text evidence' },
  ],
});
let journalFailed: boolean;
const originalLocale = locale.value;
beforeEach(() => {
  locale.value = 'en';
  journalFailed = false;
  request.mockReset().mockImplementation(async (_method, { name, input }) => {
    if (name === 'goal.session.get') return { accepted: true, goal };
    if (name === 'neo.home.read')
      return { ok: true, remoteUrl: 'https://github.com/example/neo-home' };
    if (name === 'goal.journal.list') {
      if (journalFailed) throw new Error('Journal offline');
      return {
        accepted: true,
        entries: input.before ? [entry(0)] : Array.from({ length: 20 }, (_, i) => entry(20 - i)),
      };
    }
    throw new Error(`Unexpected ${name}`);
  });
});
afterEach(() => {
  cleanup();
  locale.value = originalLocale;
});
describe('GoalDefinition', () => {
  it('shows metrics, done-test, mandate, next steps and what works through scoped reads', async () => {
    render(<GoalDefinition ownerSessionId="root" goalId="guide" />);
    for (const text of [
      'Guide for adopters',
      'readers: 30',
      'useful: true',
      'One hundred readers',
      'Write examples',
      'Concrete examples work',
    ])
      await screen.findByText(text, { exact: false });
    expect(screen.getByRole('link', { name: 'mandate.md#adoption' }).getAttribute('href')).toBe(
      'https://github.com/example/neo-home/blob/abc123/mandate.md#adoption'
    );
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.home.read',
      input: { path: 'mandate.md', includeRemote: true },
    });
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'goal.session.get',
      input: { ownerSessionId: 'root', goalId: 'guide' },
    });
  });
  it('shows loading before offering retry and offers retry only after a failed first page', async () => {
    const normal = request.getMockImplementation()!;
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    request.mockImplementation((method, data) =>
      data.name === 'goal.journal.list'
        ? new Promise((done, fail) => {
            resolve = done;
            reject = fail;
          })
        : normal(method, data)
    );
    render(<GoalDefinition ownerSessionId="root" goalId="guide" />);
    const journal = await screen.findByRole('region', { name: 'Journal' });
    await waitFor(() => expect(reject).toBeTypeOf('function'));
    expect(within(journal).getByRole('status').textContent).toBe('Loading…');
    expect(within(journal).queryByRole('button', { name: 'Retry journal' })).toBeNull();
    await act(async () => reject(new Error('Journal offline')));
    fireEvent.click(await within(journal).findByRole('button', { name: 'Retry journal' }));
    await waitFor(() =>
      expect(
        request.mock.calls.filter(([, data]) => data.name === 'goal.journal.list')
      ).toHaveLength(2)
    );
    await act(async () => resolve({ accepted: true, entries: [] }));
    await within(journal).findByText('No journal entries yet');
  });
  it('uses an em dash for unknown metrics and preserves zero and false', async () => {
    request.mockImplementationOnce(async () => ({
      accepted: true,
      goal: { ...goal, metrics: { pending: null, readers: 0, useful: false } },
    }));
    render(<GoalDefinition ownerSessionId="root" goalId="guide" />);
    await screen.findByText('pending: —');
    expect(screen.getByText('readers: 0')).toBeTruthy();
    expect(screen.getByText('useful: false')).toBeTruthy();
  });
  it.each(['refusal', 'fault'])(
    'keeps a loaded goal readable when optional home metadata returns a %s',
    async (failure) => {
      const normal = request.getMockImplementation()!;
      let finish!: () => void;
      request.mockImplementation((method, data) =>
        data.name === 'neo.home.read'
          ? new Promise((resolve, reject) => {
              finish = () =>
                failure === 'refusal'
                  ? resolve({ ok: false, reason: 'not_found: optional home document is absent' })
                  : reject(new Error('Optional metadata offline'));
            })
          : normal(method, data)
      );
      render(<GoalDefinition ownerSessionId="root" goalId="guide" />);
      await screen.findByText('Concrete examples work');
      await waitFor(() => expect(finish).toBeTypeOf('function'));
      await act(async () => {
        finish();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByText('Guide for adopters')).toBeTruthy();
      expect(screen.getByText('mandate.md#adoption')).toBeTruthy();
      expect(screen.queryByRole('link', { name: 'mandate.md#adoption' })).toBeNull();
    }
  );
  it('still reports a refused goal read without requesting optional metadata', async () => {
    request.mockResolvedValueOnce({ accepted: false, reason: 'Goal unavailable' });
    render(<GoalDefinition ownerSessionId="root" goalId="guide" />);
    expect((await screen.findByRole('alert')).textContent).toBe('Goal unavailable');
    expect(screen.queryByText('Guide for adopters')).toBeNull();
    expect(request.mock.calls.some(([, data]) => data.name === 'neo.home.read')).toBe(false);
  });
  it('pages newest-first with the last entry id and retains prior pages', async () => {
    const { container } = render(<GoalDefinition ownerSessionId="root" goalId="guide" />);
    await screen.findByText('Effect 20');
    fireEvent.click(screen.getAllByText('Effect 20')[0]);
    expect(
      within(container.querySelector('[data-journal-entry="entry-20"]')!)
        .getByRole('link', { name: 'Merged guide' })
        .getAttribute('href')
    ).toBe('https://github.com/example/repo/pull/1');
    expect(screen.queryByRole('link', { name: 'Plain text evidence' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Older entries' }));
    await screen.findByText('Effect 0');
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'goal.journal.list',
      input: { ownerSessionId: 'root', goalId: 'guide', before: 'entry-1', limit: 20 },
    });
    expect(
      [...container.querySelectorAll('[data-journal-entry]')].map((row) =>
        row.getAttribute('data-journal-entry')
      )
    ).toEqual(Array.from({ length: 21 }, (_, i) => `entry-${20 - i}`));
    expect(screen.queryByRole('button', { name: 'Older entries' })).toBeNull();
  });
  it('retains successful pages when older reads fail and retries the same cursor', async () => {
    render(<GoalDefinition ownerSessionId="root" goalId="guide" />);
    await screen.findByText('Effect 20');
    journalFailed = true;
    fireEvent.click(screen.getByRole('button', { name: 'Older entries' }));
    await screen.findByText('Journal offline');
    expect(screen.getByText('Effect 20')).toBeTruthy();
    journalFailed = false;
    fireEvent.click(screen.getByRole('button', { name: 'Older entries' }));
    await screen.findByText('Effect 0');
  });
  it('keeps the mandate as text when there is no browser remote', async () => {
    request.mockImplementation(async (_method, { name }) =>
      name === 'goal.session.get'
        ? { accepted: true, goal }
        : name === 'neo.home.read'
          ? { ok: true, remoteUrl: null }
          : { accepted: true, entries: [] }
    );
    render(<GoalDefinition ownerSessionId="root" goalId="guide" />);
    await screen.findByText('mandate.md#adoption');
    expect(screen.queryByRole('link', { name: 'mandate.md#adoption' })).toBeNull();
    await screen.findByText('No journal entries yet');
  });
  it('discards old goal reads after the selected goal changes', async () => {
    let finish!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const { rerender } = render(<GoalDefinition ownerSessionId="root" goalId="old" />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    rerender(<GoalDefinition ownerSessionId="root" goalId="guide" />);
    await screen.findByText('Guide for adopters');
    await act(async () =>
      finish({ accepted: true, goal: { ...goal, description: 'Old private details' } })
    );
    expect(screen.queryByText('Old private details')).toBeNull();
  });
});

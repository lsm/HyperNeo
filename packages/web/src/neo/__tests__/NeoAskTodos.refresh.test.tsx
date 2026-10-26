import type { NeoAskEntry } from '@hyperneo/shared/types/neo-ask';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { locale } from '../../lib/i18n/index.ts';
import { NeoAskTodos } from '../NeoAskTodos.tsx';
import { testAskEntry, testTodo } from './neo-test-views.ts';

beforeEach(() => {
  locale.value = 'en';
  sessionStorage.clear();
});
afterEach(() => cleanup());

function full(revision: number, id = 'ask'): NeoAskEntry {
  const entry = testAskEntry(id, `Card ${id}`, {
    todos: [
      testTodo('work', {
        askId: id,
        instruction: 'Full instructions',
        report: `Report ${revision}`,
      }),
    ],
  });
  return { ...entry, ask: { ...entry.ask, updatedAt: revision } };
}
function summary(revision: number, id = 'ask'): NeoAskEntry {
  const entry = full(revision, id);
  return {
    ...entry,
    summary: { todoCount: 1, questionCount: 0, openQuestionCount: 0 },
    todos: entry.todos.map((todo) => ({ ...todo, instruction: null, report: null })),
  };
}
function held() {
  let resolve!: (entry: NeoAskEntry) => void;
  const promise = new Promise<NeoAskEntry>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function mount(load: (id: string) => Promise<NeoAskEntry>) {
  const answer = vi.fn();
  const view = render(<NeoAskTodos entry={summary(1)} onAnswer={answer} onLoadDetails={load} />);
  return {
    ...view,
    refresh: async (entry: NeoAskEntry) =>
      act(async () =>
        view.rerender(<NeoAskTodos entry={entry} onAnswer={answer} onLoadDetails={load} />)
      ),
  };
}
const openRow = (view: ReturnType<typeof mount>) =>
  fireEvent.click(view.getByRole('button', { name: 'Show details: Todo work' }));

it('keeps one pending read through equivalent full-snapshot refreshes', async () => {
  const read = held();
  const load = vi.fn(() => read.promise);
  const view = mount(load);
  openRow(view);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  await view.refresh(summary(1));
  await view.refresh(summary(1));
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => read.resolve(full(1)));
  expect(await view.findByText('Report 1')).toBeTruthy();
  await view.refresh(summary(1));
  expect(view.getByText('Report 1')).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(1);
});

it('finishes the pending read then reconciles only the newest changed card', async () => {
  const first = held(),
    latest = held();
  const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
  const view = mount(load);
  openRow(view);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  await view.refresh(summary(2));
  await view.refresh(summary(3));
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => first.resolve(full(1)));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(view.getByText('Report 1')).toBeTruthy();
  await act(async () => latest.resolve(full(3)));
  expect(await view.findByText('Report 3')).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(2);
});

it('keeps loaded bodies visible while a changed card refreshes', async () => {
  const next = held();
  const load = vi.fn().mockResolvedValueOnce(full(1)).mockReturnValueOnce(next.promise);
  const view = mount(load);
  openRow(view);
  expect(await view.findByText('Report 1')).toBeTruthy();
  const updated = { ...summary(2), state: 'doing' as const };
  await view.refresh(updated);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(view.getByText('Report 1')).toBeTruthy();
  expect(view.container.querySelector('[data-ask]')?.getAttribute('data-ask-state')).toBe('doing');
  await act(async () => next.resolve({ ...full(2), state: 'doing' }));
  expect(await view.findByText('Report 2')).toBeTruthy();
});

it('keeps a failed read stable on equivalent refreshes and retries on reopening', async () => {
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error('Read failed'))
    .mockResolvedValueOnce(full(1));
  const view = mount(load);
  openRow(view);
  expect(await view.findByText('Read failed')).toBeTruthy();
  await view.refresh(summary(1));
  expect(view.getByText('Read failed')).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(1);
  fireEvent.click(view.getByRole('button', { name: 'Hide details: Todo work' }));
  openRow(view);
  expect(await view.findByText('Report 1')).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(2);
});

it('ignores a pending response after switching to another ask', async () => {
  const first = held(),
    second = held();
  const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const view = mount(load);
  openRow(view);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  await view.refresh(summary(2, 'other'));
  openRow(view);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await act(async () => first.resolve(full(1)));
  expect(view.queryByText('Report 1')).toBeNull();
  await act(async () => second.resolve(full(2, 'other')));
  expect(await view.findByText('Report 2')).toBeTruthy();
});

import { cleanup, renderHook, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useNeoWorkSearch } from '../useNeoWorkSearch.ts';
import { testAskEntry, testTodo } from './neo-test-views.ts';

const full = testAskEntry('a', 'Synthetic work', {
  todos: [testTodo('step', { title: 'Step', status: 'Ready', report: 'Hidden report needle' })],
});
const entries = [
  {
    ...full,
    summary: { todoCount: 1, questionCount: 0, openQuestionCount: 0 },
    todos: full.todos.map((todo) => ({ ...todo, report: null })),
  },
];
afterEach(cleanup);

describe('Work search source', () => {
  it('finds an old Chinese card outside the loaded feed through server search', async () => {
    const old = testAskEntry('old-unloaded', '网页修两处', { state: 'done' });
    const read = vi.fn(async (id: string) => (id === old.ask.id ? old : full));
    const find = vi.fn(async () => [{ askId: old.ask.id }, { askId: old.ask.id }]);
    const view = renderHook(() => useNeoWorkSearch(entries, '网页修两处', read, find));
    await waitFor(() =>
      expect(view.result.current.results.map((entry) => entry.ask.id)).toEqual([old.ask.id])
    );
    expect(view.result.current.pending).toBe(false);
    expect(view.result.current.failed).toBe(false);
  });
  it('reads summary bodies once for a search and reuses them for later queries', async () => {
    const read = vi.fn(async () => full);
    const view = renderHook(({ query }) => useNeoWorkSearch(entries, query, read), {
      initialProps: { query: '' },
    });
    expect(read).not.toHaveBeenCalled();
    view.rerender({ query: 'needle' });
    await waitFor(() =>
      expect(view.result.current.results.map((entry) => entry.ask.id)).toEqual(['a'])
    );
    view.rerender({ query: 'hidden' });
    expect(view.result.current.results).toEqual([full]);
    expect(read).toHaveBeenCalledTimes(1);
    view.rerender({ query: 'unmatched' });
    expect(view.result.current.results).toEqual([]);
    expect(view.result.current.pending).toBe(false);
  });
  it('reports a read failure rather than treating unread report bodies as no matches', async () => {
    const read = vi.fn(async () => {
      throw new Error('Synthetic unavailable');
    });
    const view = renderHook(() => useNeoWorkSearch(entries, 'needle', read));
    await waitFor(() => expect(view.result.current.failed).toBe(true));
    expect(view.result.current.pending).toBe(false);
  });

  it('keeps results across fresh snapshots and reads only changed card bodies', async () => {
    const other = { ...full, ask: { ...full.ask, id: 'b' } };
    const source = [entries[0], { ...entries[0], ask: other.ask }];
    let finish!: (entry: typeof full) => void;
    const read = vi.fn(async (id: string) => (id === 'a' ? full : other));
    const view = renderHook(({ values }) => useNeoWorkSearch(values, 'needle', read), {
      initialProps: { values: source },
    });
    await waitFor(() => expect(view.result.current.results).toHaveLength(2));
    view.rerender({ values: source.map((entry) => ({ ...entry, ask: { ...entry.ask } })) });
    expect(view.result.current.results).toHaveLength(2);
    expect(view.result.current.pending).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    read.mockImplementation((id) =>
      id === 'a'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(other)
    );
    view.rerender({ values: [{ ...source[0], ask: { ...full.ask, updatedAt: 2 } }, source[1]] });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    expect(view.result.current.results).toHaveLength(2);
    expect(view.result.current.pending).toBe(true);
    finish({ ...full, ask: { ...full.ask, updatedAt: 2 } });
    await waitFor(() => expect(view.result.current.pending).toBe(false));
    expect(view.result.current.results).toHaveLength(2);
  });
});

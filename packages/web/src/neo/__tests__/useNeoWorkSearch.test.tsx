import { act, cleanup, renderHook, waitFor } from '@testing-library/preact';
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
const noRemote = async () => ({ results: [], nextCursor: null });

describe('Work search source', () => {
  it('starts from the first page when returning to a previously paged query', async () => {
    const find = async (query: string, cursor?: string) => ({
      results: [{ askId: `${query}-${cursor ?? 'first'}` }],
      nextCursor: cursor ? null : 'next',
    });
    const read = async (id: string) => testAskEntry(id, id);
    const view = renderHook(({ query }) => useNeoWorkSearch([], query, read, find), {
      initialProps: { query: 'alpha' },
    });
    await waitFor(() => expect(view.result.current.pending).toBe(false));
    act(() => view.result.current.loadMore());
    await waitFor(() => expect(view.result.current.results).toHaveLength(2));
    view.rerender({ query: 'beta' });
    await waitFor(() => expect(view.result.current.pending).toBe(false));
    view.rerender({ query: 'alpha' });
    await waitFor(() => expect(view.result.current.pending).toBe(false));
    expect(view.result.current.results.map((entry) => entry.ask.id)).toEqual(['alpha-first']);
  });
  it('bounds simultaneous unloaded card reads', async () => {
    let active = 0;
    const releases: (() => void)[] = [];
    const read = vi.fn(async (id: string) => {
      active++;
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return testAskEntry(id, 'Broad match');
    });
    const find = async () => ({
      results: Array.from({ length: 12 }, (_, i) => ({ askId: `old-${i}` })),
      nextCursor: null,
    });
    const view = renderHook(() => useNeoWorkSearch([], 'e', read, find));
    try {
      await waitFor(() => expect(read).toHaveBeenCalled());
      expect(active).toBeLessThanOrEqual(4);
    } finally {
      view.unmount();
      for (const release of releases) release();
    }
  });
  it('reuses unloaded reads across feed revisions', async () => {
    const old = testAskEntry('old', 'Unloaded needle');
    const read = vi.fn(async () => old);
    const find = async () => ({ results: [{ askId: old.ask.id }], nextCursor: null });
    const view = renderHook(({ values }) => useNeoWorkSearch(values, 'needle', read, find), {
      initialProps: { values: [full] },
    });
    await waitFor(() => expect(view.result.current.pending).toBe(false));
    view.rerender({ values: [{ ...full, ask: { ...full.ask, updatedAt: 2 } }] });
    await waitFor(() => expect(view.result.current.pending).toBe(false));
    expect(view.result.current.results.some((entry) => entry.ask.id === old.ask.id)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it.each(['search', 'hydration'])('keeps loaded matches when remote %s fails', async (failure) => {
    const read = vi.fn(async (id: string) => {
      if (id === 'missing') throw new Error('Card unavailable');
      return full;
    });
    const find = vi.fn(async () => {
      if (failure === 'search') throw new Error('Search unavailable');
      return { results: [{ askId: 'missing' }], nextCursor: null };
    });
    const view = renderHook(() => useNeoWorkSearch(entries, 'needle', read, find));
    await waitFor(() => expect(view.result.current.failed).toBe(true));
    expect(view.result.current.results.map((entry) => entry.ask.id)).toEqual(['a']);
    expect(view.result.current.pending).toBe(false);
  });
  it('finds an old Chinese card outside the loaded feed through server search', async () => {
    const old = testAskEntry('old-unloaded', '网页修两处', { state: 'done' });
    const read = vi.fn(async (id: string) => (id === old.ask.id ? old : full));
    const find = vi.fn(async () => ({
      results: [{ askId: old.ask.id }, { askId: old.ask.id }],
      nextCursor: null,
    }));
    const view = renderHook(() => useNeoWorkSearch(entries, '网页修两处', read, find));
    await waitFor(() =>
      expect(view.result.current.results.map((entry) => entry.ask.id)).toEqual([old.ask.id])
    );
    await waitFor(() => expect(view.result.current.pending).toBe(false));
    expect(view.result.current.failed).toBe(false);
  });
  it('does not show a late old-card result after the query changes', async () => {
    const old = testAskEntry('old-unloaded', '网页修两处');
    let release!: (page: { results: { askId: string }[]; nextCursor: null }) => void;
    const find = vi.fn((query: string) =>
      query === '网页修两处'
        ? new Promise<{ results: { askId: string }[]; nextCursor: null }>((resolve) => {
            release = resolve;
          })
        : Promise.resolve({ results: [], nextCursor: null })
    );
    const read = vi.fn(async () => old);
    const view = renderHook(({ query }) => useNeoWorkSearch([], query, read, find), {
      initialProps: { query: '网页修两处' },
    });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    view.rerender({ query: 'missing' });
    await waitFor(() => expect(view.result.current.pending).toBe(false));
    await act(async () => release({ results: [{ askId: old.ask.id }], nextCursor: null }));
    expect(read).not.toHaveBeenCalled();
    expect(view.result.current.results).toEqual([]);
  });
  it('reports unavailable server search instead of falsely showing no matches', async () => {
    const find = vi.fn(async () => {
      throw new Error('Search unavailable');
    });
    const read = vi.fn(async () => full);
    const view = renderHook(() => useNeoWorkSearch([], '网页修两处', read, find));
    await waitFor(() => expect(view.result.current.failed).toBe(true));
    expect(view.result.current.pending).toBe(false);
  });
  it('reads summary bodies once for a search and reuses them for later queries', async () => {
    const read = vi.fn(async () => full);
    const view = renderHook(({ query }) => useNeoWorkSearch(entries, query, read, noRemote), {
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
    await waitFor(() => expect(view.result.current.pending).toBe(false));
  });
  it('reports a read failure rather than treating unread report bodies as no matches', async () => {
    const read = vi.fn(async () => {
      throw new Error('Synthetic unavailable');
    });
    const view = renderHook(() => useNeoWorkSearch(entries, 'needle', read, noRemote));
    await waitFor(() => expect(view.result.current.failed).toBe(true));
    await waitFor(() => expect(view.result.current.pending).toBe(false));
  });

  it('keeps results across fresh snapshots and reads only changed card bodies', async () => {
    const other = { ...full, ask: { ...full.ask, id: 'b' } };
    const source = [entries[0], { ...entries[0], ask: other.ask }];
    let finish!: (entry: typeof full) => void;
    const read = vi.fn(async (id: string) => (id === 'a' ? full : other));
    const view = renderHook(({ values }) => useNeoWorkSearch(values, 'needle', read, noRemote), {
      initialProps: { values: source },
    });
    await waitFor(() => expect(view.result.current.results).toHaveLength(2));
    view.rerender({ values: source.map((entry) => ({ ...entry, ask: { ...entry.ask } })) });
    expect(view.result.current.results).toHaveLength(2);
    await waitFor(() => expect(view.result.current.pending).toBe(false));
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

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
});

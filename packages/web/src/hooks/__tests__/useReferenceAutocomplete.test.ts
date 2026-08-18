// @ts-nocheck

import { renderHook, act } from '@testing-library/preact';
import {
  useReferenceAutocomplete,
  extractActiveAtQuery,
  insertReferenceMention,
} from '../useReferenceAutocomplete.ts';

const mockActiveSessionId = vi.hoisted(() => ({ value: 'session-123' }));

vi.mock('../../lib/session-store.ts', () => ({
  sessionStore: {
    activeSessionId: mockActiveSessionId,
  },
}));

const mockRequest = vi.hoisted(() => vi.fn());
const mockGetHubIfConnected = vi.hoisted(() => vi.fn(() => ({ request: mockRequest })));

vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHubIfConnected: mockGetHubIfConnected,
  },
}));

const makeResults = (count = 3) =>
  Array.from({ length: count }, (_, i) => ({
    type: 'task' as const,
    id: `task-${i}`,
    shortId: `t-${i}`,
    displayText: `Task ${i}`,
    subtitle: 'open',
  }));

describe('extractActiveAtQuery', () => {
  it('returns null when no @ present', () => {
    expect(extractActiveAtQuery('hello world')).toBeNull();
  });

  it('returns empty string when content is just @', () => {
    expect(extractActiveAtQuery('@')).toBe('');
  });

  it('returns query for @ at start', () => {
    expect(extractActiveAtQuery('@foo')).toBe('foo');
  });

  it('returns query for @ in middle of text', () => {
    expect(extractActiveAtQuery('hello @foo')).toBe('foo');
  });

  it('returns null when @ is followed by space (completed mention)', () => {
    expect(extractActiveAtQuery('@foo bar')).toBeNull();
  });

  it('returns query for last @ when multiple in text', () => {
    expect(extractActiveAtQuery('@done fix @new')).toBe('new');
  });

  it('returns null when last @ is completed and earlier one is also done', () => {
    expect(extractActiveAtQuery('@foo bar @baz qux')).toBeNull();
  });

  it('handles @ embedded in word (not word-start) — should not trigger', () => {
    expect(extractActiveAtQuery('email@example.com')).toBeNull();
  });

  it('handles multiple @ with only last active', () => {
    expect(extractActiveAtQuery('Fix @ref{task:t-1} and @ne')).toBe('ne');
  });

  it('returns empty string for trailing @', () => {
    expect(extractActiveAtQuery('hello @')).toBe('');
  });
});

describe('insertReferenceMention', () => {
  it('replaces @query at end of content with @ref token', () => {
    const mention = { type: 'task' as const, id: 't-42', displayText: 'Fix bug' };
    const result = insertReferenceMention('fix @bug', 'bug', mention);
    expect(result).toBe('fix @ref{task:t-42} ');
  });

  it('replaces empty query (just @) with @ref token', () => {
    const mention = { type: 'goal' as const, id: 'g-7', displayText: 'Goal' };
    const result = insertReferenceMention('hello @', '', mention);
    expect(result).toBe('hello @ref{goal:g-7} ');
  });

  it('returns content unchanged when @query is not at end', () => {
    const mention = { type: 'task' as const, id: 't-1', displayText: 'Task' };
    const result = insertReferenceMention('hello world', 'world', mention);
    expect(result).toBe('hello world');
  });

  it('appends trailing space after token', () => {
    const mention = { type: 'file' as const, id: 'src/foo.ts', displayText: 'foo.ts' };
    const result = insertReferenceMention('@foo', 'foo', mention);
    expect(result).toBe('@ref{file:src/foo.ts} ');
  });

  it('handles file references with path as id', () => {
    const mention = { type: 'folder' as const, id: 'src/components', displayText: 'components' };
    const result = insertReferenceMention('look at @comp', 'comp', mention);
    expect(result).toBe('look at @ref{folder:src/components} ');
  });

  it('handles content with existing @ref tokens before the active query', () => {
    const mention = { type: 'task' as const, id: 't-5', displayText: 'Task 5' };
    const result = insertReferenceMention('@ref{task:t-1} fix @bug', 'bug', mention);
    expect(result).toBe('@ref{task:t-1} fix @ref{task:t-5} ');
  });

  it('returns unchanged content when suffix does not match', () => {
    const mention = { type: 'task' as const, id: 't-1', displayText: 'Task' };
    const result = insertReferenceMention('hello @world', 'xyz', mention);
    expect(result).toBe('hello @world');
  });
});

describe('useReferenceAutocomplete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockActiveSessionId.value = 'session-123';
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValue({ results: makeResults() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('initializes with autocomplete hidden', () => {
      const { result } = renderHook(() =>
        useReferenceAutocomplete({ content: '', onSelect: vi.fn() })
      );

      expect(result.current.showAutocomplete).toBe(false);
      expect(result.current.results).toEqual([]);
      expect(result.current.selectedIndex).toBe(0);
      expect(result.current.searchQuery).toBe('');
    });

    it('provides required functions', () => {
      const { result } = renderHook(() =>
        useReferenceAutocomplete({ content: '', onSelect: vi.fn() })
      );

      expect(typeof result.current.handleSelect).toBe('function');
      expect(typeof result.current.handleKeyDown).toBe('function');
      expect(typeof result.current.close).toBe('function');
    });
  });

  describe('@ detection', () => {
    it('triggers search when @ is typed at start', async () => {
      const { result } = renderHook(() =>
        useReferenceAutocomplete({ content: '@', onSelect: vi.fn() })
      );

      expect(result.current.searchQuery).toBe('');

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(mockRequest).toHaveBeenCalledWith('reference.search', {
        sessionId: 'session-123',
        query: '',
      });
      expect(result.current.showAutocomplete).toBe(true);
    });

    it('triggers search when @ is in the middle of text', async () => {
      const { result } = renderHook(() =>
        useReferenceAutocomplete({ content: 'fix @bug', onSelect: vi.fn() })
      );

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(mockRequest).toHaveBeenCalledWith('reference.search', {
        sessionId: 'session-123',
        query: 'bug',
      });
    });

    it('does not trigger when content has no @', async () => {
      renderHook(() => useReferenceAutocomplete({ content: 'hello world', onSelect: vi.fn() }));

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('does not trigger when @ mention is completed (space after query)', async () => {
      renderHook(() => useReferenceAutocomplete({ content: '@foo bar', onSelect: vi.fn() }));

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  describe('debouncing', () => {
    it('does not call RPC before debounce delay', async () => {
      renderHook(() => useReferenceAutocomplete({ content: '@foo', onSelect: vi.fn() }));

      await act(async () => {
        vi.advanceTimersByTime(299);
      });

      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('calls RPC after debounce delay', async () => {
      renderHook(() => useReferenceAutocomplete({ content: '@foo', onSelect: vi.fn() }));

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('cancels previous debounce on new input', async () => {
      const { rerender } = renderHook(
        ({ content }) => useReferenceAutocomplete({ content, onSelect: vi.fn() }),
        { initialProps: { content: '@fo' } }
      );

      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      rerender({ content: '@foo' });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(mockRequest).toHaveBeenCalledWith('reference.search', {
        sessionId: 'session-123',
        query: 'foo',
      });
    });
  });

  describe('results handling', () => {
    it('shows results after successful search', async () => {
      const results = makeResults(3);
      mockRequest.mockResolvedValue({ results });

      const { result } = renderHook(() =>
        useReferenceAutocomplete({ content: '@task', onSelect: vi.fn() })
      );

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      expect(result.current.results).toEqual(results);
      expect(result.current.showAutocomplete).toBe(true);
      expect(result.current.selectedIndex).toBe(0);
    });

    it('hides autocomplete when search returns empty results', async () => {
      mockRequest.mockResolvedValue({ results: [] });

      const { result } = renderHook(() =>
        useReferenceAutocomplete({ content: '@xyz', onSelect: vi.fn() })
      );

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      expect(result.current.showAutocomplete).toBe(false);
      expect(result.current.results).toEqual([]);
    });

    it('hides autocomplete on search error', async () => {
      mockRequest.mockRejectedValue(new Error('RPC error'));

      const { result } = renderHook(() =>
        useReferenceAutocomplete({ content: '@task', onSelect: vi.fn() })
      );

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      expect(result.current.showAutocomplete).toBe(false);
    });

    it('hides autocomplete when hub is not connected', async () => {
      mockGetHubIfConnected.mockReturnValue(null);

      const { result } = renderHook(() =>
        useReferenceAutocomplete({ content: '@task', onSelect: vi.fn() })
      );

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      expect(result.current.showAutocomplete).toBe(false);
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('hides autocomplete when no active session', async () => {
      mockActiveSessionId.value = null;

      const { result } = renderHook(() =>
        useReferenceAutocomplete({ content: '@task', onSelect: vi.fn() })
      );

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      expect(result.current.showAutocomplete).toBe(false);
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  describe('handleSelect', () => {
    it('calls onSelect with ReferenceMention and closes autocomplete', async () => {
      const results = makeResults(2);
      mockRequest.mockResolvedValue({ results });
      const onSelect = vi.fn();

      const { result } = renderHook(() => useReferenceAutocomplete({ content: '@task', onSelect }));

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      act(() => {
        result.current.handleSelect(results[0]);
      });

      expect(onSelect).toHaveBeenCalledWith({
        type: results[0].type,
        id: results[0].id,
        displayText: results[0].displayText,
      });
      expect(result.current.showAutocomplete).toBe(false);
    });
  });

  describe('close', () => {
    it('closes autocomplete and resets results and selectedIndex', async () => {
      mockRequest.mockResolvedValue({ results: makeResults(3) });

      const { result } = renderHook(() =>
        useReferenceAutocomplete({ content: '@task', onSelect: vi.fn() })
      );

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      expect(result.current.showAutocomplete).toBe(true);
      expect(result.current.results).toHaveLength(3);

      const e = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      Object.defineProperty(e, 'preventDefault', { value: vi.fn() });
      act(() => {
        result.current.handleKeyDown(e);
      });
      expect(result.current.selectedIndex).toBe(1);

      act(() => {
        result.current.close();
      });

      expect(result.current.showAutocomplete).toBe(false);
      expect(result.current.results).toEqual([]);
      expect(result.current.selectedIndex).toBe(0);
    });
  });

  describe('handleKeyDown', () => {
    it('returns false when autocomplete is hidden', () => {
      const { result } = renderHook(() =>
        useReferenceAutocomplete({ content: '', onSelect: vi.fn() })
      );

      const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      let handled: boolean;
      act(() => {
        handled = result.current.handleKeyDown(event);
      });

      expect(handled!).toBe(false);
    });

    it('handles ArrowDown to navigate forward', async () => {
      const results = makeResults(3);
      mockRequest.mockResolvedValue({ results });

      const { result } = renderHook(() =>
        useReferenceAutocomplete({ content: '@task', onSelect: vi.fn() })
      );

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      expect(result.current.selectedIndex).toBe(0);

      const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      const preventDefault = vi.fn();
      Object.defineProperty(event, 'preventDefault', { value: preventDefault });

      act(() => {
        const handled = result.current.handleKeyDown(event);
        expect(handled).toBe(true);
      });

      expect(result.current.selectedIndex).toBe(1);
      expect(preventDefault).toHaveBeenCalled();
    });

    it('handles ArrowUp to navigate backward', async () => {
      const results = makeResults(3);
      mockRequest.mockResolvedValue({ results });

      const { result } = renderHook(() =>
        useReferenceAutocomplete({ content: '@task', onSelect: vi.fn() })
      );

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      const down1 = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      Object.defineProperty(down1, 'preventDefault', { value: vi.fn() });
      const down2 = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      Object.defineProperty(down2, 'preventDefault', { value: vi.fn() });

      act(() => {
        result.current.handleKeyDown(down1);
        result.current.handleKeyDown(down2);
      });

      expect(result.current.selectedIndex).toBe(2);

      const up = new KeyboardEvent('keydown', { key: 'ArrowUp' });
      Object.defineProperty(up, 'preventDefault', { value: vi.fn() });

      act(() => {
        result.current.handleKeyDown(up);
      });

      expect(result.current.selectedIndex).toBe(1);
    });

    it('wraps ArrowDown past end to first item', async () => {
      const results = makeResults(3);
      mockRequest.mockResolvedValue({ results });

      const { result } = renderHook(() =>
        useReferenceAutocomplete({ content: '@task', onSelect: vi.fn() })
      );

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      for (let i = 0; i < 2; i++) {
        const e = new KeyboardEvent('keydown', { key: 'ArrowDown' });
        Object.defineProperty(e, 'preventDefault', { value: vi.fn() });
        act(() => {
          result.current.handleKeyDown(e);
        });
      }

      expect(result.current.selectedIndex).toBe(2);

      const e = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      Object.defineProperty(e, 'preventDefault', { value: vi.fn() });
      act(() => {
        result.current.handleKeyDown(e);
      });

      expect(result.current.selectedIndex).toBe(0);
    });

    it('wraps ArrowUp before start to last item', async () => {
      const results = makeResults(3);
      mockRequest.mockResolvedValue({ results });

      const { result } = renderHook(() =>
        useReferenceAutocomplete({ content: '@task', onSelect: vi.fn() })
      );

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      expect(result.current.selectedIndex).toBe(0);

      const e = new KeyboardEvent('keydown', { key: 'ArrowUp' });
      Object.defineProperty(e, 'preventDefault', { value: vi.fn() });
      act(() => {
        result.current.handleKeyDown(e);
      });

      expect(result.current.selectedIndex).toBe(2);
    });

    it('selects item with Enter', async () => {
      const results = makeResults(2);
      mockRequest.mockResolvedValue({ results });
      const onSelect = vi.fn();

      const { result } = renderHook(() => useReferenceAutocomplete({ content: '@task', onSelect }));

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      const event = new KeyboardEvent('keydown', { key: 'Enter' });
      const preventDefault = vi.fn();
      Object.defineProperty(event, 'preventDefault', { value: preventDefault });

      act(() => {
        const handled = result.current.handleKeyDown(event);
        expect(handled).toBe(true);
      });

      expect(onSelect).toHaveBeenCalledWith({
        type: results[0].type,
        id: results[0].id,
        displayText: results[0].displayText,
      });
      expect(result.current.showAutocomplete).toBe(false);
      expect(preventDefault).toHaveBeenCalled();
    });

    it('does not handle Enter with metaKey', async () => {
      const results = makeResults(2);
      mockRequest.mockResolvedValue({ results });
      const onSelect = vi.fn();

      const { result } = renderHook(() => useReferenceAutocomplete({ content: '@task', onSelect }));

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      const event = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true });

      act(() => {
        const handled = result.current.handleKeyDown(event);
        expect(handled).toBe(false);
      });

      expect(onSelect).not.toHaveBeenCalled();
    });

    it('does not handle Enter with ctrlKey', async () => {
      const results = makeResults(2);
      mockRequest.mockResolvedValue({ results });
      const onSelect = vi.fn();

      const { result } = renderHook(() => useReferenceAutocomplete({ content: '@task', onSelect }));

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      const event = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true });

      act(() => {
        const handled = result.current.handleKeyDown(event);
        expect(handled).toBe(false);
      });

      expect(onSelect).not.toHaveBeenCalled();
    });

    it('closes autocomplete with Escape and resets results and selectedIndex', async () => {
      mockRequest.mockResolvedValue({ results: makeResults(3) });

      const { result } = renderHook(() =>
        useReferenceAutocomplete({ content: '@task', onSelect: vi.fn() })
      );

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      expect(result.current.showAutocomplete).toBe(true);
      expect(result.current.results).toHaveLength(3);

      const down = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      Object.defineProperty(down, 'preventDefault', { value: vi.fn() });
      act(() => {
        result.current.handleKeyDown(down);
      });
      expect(result.current.selectedIndex).toBe(1);

      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      const preventDefault = vi.fn();
      Object.defineProperty(event, 'preventDefault', { value: preventDefault });

      act(() => {
        const handled = result.current.handleKeyDown(event);
        expect(handled).toBe(true);
      });

      expect(result.current.showAutocomplete).toBe(false);
      expect(result.current.results).toEqual([]);
      expect(result.current.selectedIndex).toBe(0);
      expect(preventDefault).toHaveBeenCalled();
    });
  });

  describe('multiple @ in same message', () => {
    it('triggers on last active @ when earlier ones are completed', async () => {
      mockRequest.mockResolvedValue({ results: makeResults() });

      const { result } = renderHook(() =>
        useReferenceAutocomplete({
          content: 'Fix @ref{task:t-1} and @ne',
          onSelect: vi.fn(),
        })
      );

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      expect(mockRequest).toHaveBeenCalledWith('reference.search', {
        sessionId: 'session-123',
        query: 'ne',
      });
      expect(result.current.searchQuery).toBe('ne');
      expect(result.current.showAutocomplete).toBe(true);
    });

    it('does not trigger when all @ mentions are completed', async () => {
      const { result } = renderHook(() =>
        useReferenceAutocomplete({
          content: '@foo done @bar done',
          onSelect: vi.fn(),
        })
      );

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      expect(mockRequest).not.toHaveBeenCalled();
      expect(result.current.showAutocomplete).toBe(false);
    });
  });

  describe('stale response cancellation', () => {
    it('ignores response from superseded search', async () => {
      let resolveFirst!: (v: unknown) => void;
      const firstPromise = new Promise((res) => {
        resolveFirst = res;
      });

      mockRequest.mockReturnValueOnce(firstPromise).mockResolvedValue({ results: makeResults(2) });

      const { result, rerender } = renderHook(
        ({ content }) => useReferenceAutocomplete({ content, onSelect: vi.fn() }),
        { initialProps: { content: '@fo' } }
      );

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      rerender({ content: '@foo' });

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      await act(async () => {
        resolveFirst({ results: makeResults(5) });
        await Promise.resolve();
      });

      expect(result.current.results).toHaveLength(2);
    });
  });
});

// @ts-nocheck

import { renderHook, act } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useInputDraft } from '../useInputDraft.ts';
import { connectionManager } from '../../lib/connection-manager.ts';
import { connectionState } from '../../lib/state.ts';
import { resetVoiceTranscriptOutbox } from '../../lib/voice/voice-transcript-outbox.ts';

vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHubIfConnected: vi.fn(),
  },
}));

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
  } as Storage;
}

const originalStorage = globalThis.localStorage;

describe('useInputDraft', () => {
  const mockHub = {
    request: vi.fn().mockResolvedValue({ acknowledged: true }),
    event: vi.fn(),
    onRequest: vi.fn().mockReturnValue(() => {}),
    onEvent: vi.fn().mockReturnValue(() => {}),
    joinRoom: vi.fn(),
    leaveRoom: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    onConnection: vi.fn().mockReturnValue(() => {}),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    globalThis.localStorage = createMemoryStorage();
    resetVoiceTranscriptOutbox();
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
  });

  afterEach(() => {
    globalThis.localStorage = originalStorage;
    connectionState.value = 'connecting';
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('should initialize with empty content', () => {
      const { result } = renderHook(() => useInputDraft('session-1'));

      expect(result.current.content).toBe('');
    });

    it('should provide setContent function', () => {
      const { result } = renderHook(() => useInputDraft('session-1'));

      expect(typeof result.current.setContent).toBe('function');
    });

    it('should provide clear function', () => {
      const { result } = renderHook(() => useInputDraft('session-1'));

      expect(typeof result.current.clear).toBe('function');
    });
  });

  describe('setContent', () => {
    it('should update content synchronously', () => {
      const { result } = renderHook(() => useInputDraft('session-1'));

      act(() => {
        result.current.setContent('Hello world');
      });

      expect(result.current.content).toBe('Hello world');
    });

    it('should handle multiple rapid updates', () => {
      const { result } = renderHook(() => useInputDraft('session-1'));

      act(() => {
        result.current.setContent('H');
        result.current.setContent('He');
        result.current.setContent('Hel');
        result.current.setContent('Hell');
        result.current.setContent('Hello');
      });

      expect(result.current.content).toBe('Hello');
    });

    it('should handle special characters', () => {
      const { result } = renderHook(() => useInputDraft('session-1'));

      act(() => {
        result.current.setContent('Hello <world> & "friends"');
      });

      expect(result.current.content).toBe('Hello <world> & "friends"');
    });

    it('should handle multiline content', () => {
      const { result } = renderHook(() => useInputDraft('session-1'));

      act(() => {
        result.current.setContent('Line 1\nLine 2\nLine 3');
      });

      expect(result.current.content).toBe('Line 1\nLine 2\nLine 3');
    });
  });

  describe('clear', () => {
    it('should clear content', () => {
      const { result } = renderHook(() => useInputDraft('session-1'));

      act(() => {
        result.current.setContent('Some content');
      });

      expect(result.current.content).toBe('Some content');

      act(() => {
        result.current.clear();
      });

      expect(result.current.content).toBe('');
    });

    it('should work when content is already empty', () => {
      const { result } = renderHook(() => useInputDraft('session-1'));

      act(() => {
        result.current.clear();
      });

      expect(result.current.content).toBe('');
    });
  });

  describe('session switching', () => {
    it('should clear content when switching sessions', () => {
      const { result, rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId), {
        initialProps: { sessionId: 'session-1' },
      });

      act(() => {
        result.current.setContent('Content for session 1');
      });

      expect(result.current.content).toBe('Content for session 1');

      rerender({ sessionId: 'session-2' });

      expect(result.current.content).toBe('');
    });

    it('should handle empty sessionId', () => {
      const { result } = renderHook(() => useInputDraft(''));

      expect(result.current.content).toBe('');
    });

    it('should handle rapid session switches', () => {
      const { result, rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId), {
        initialProps: { sessionId: 'session-1' },
      });

      rerender({ sessionId: 'session-2' });
      rerender({ sessionId: 'session-3' });
      rerender({ sessionId: 'session-4' });

      expect(result.current.content).toBe('');
    });
  });

  describe('function stability', () => {
    it('should return stable setContent reference', () => {
      const { result, rerender } = renderHook(() => useInputDraft('session-1'));

      const firstSetContent = result.current.setContent;

      rerender();

      expect(result.current.setContent).toBe(firstSetContent);
    });

    it('should return stable clear reference', () => {
      const { result, rerender } = renderHook(() => useInputDraft('session-1'));

      const firstClear = result.current.clear;

      rerender();

      expect(result.current.clear).toBe(firstClear);
    });
  });

  describe('custom debounce delay', () => {
    it('should accept custom debounce delay parameter', () => {
      const { result } = renderHook(() => useInputDraft('session-1', 500));

      expect(result.current.content).toBe('');
    });
  });

  describe('content getter behavior', () => {
    it('should return current content value', () => {
      const { result } = renderHook(() => useInputDraft('session-1'));

      act(() => {
        result.current.setContent('Test');
      });

      expect(result.current.content).toBe('Test');
      expect(result.current.content).toBe('Test');
    });
  });

  describe('draft loading', () => {
    it('should load draft from session when hub is connected', async () => {
      mockHub.request.mockResolvedValue({
        session: { metadata: { inputDraft: 'Saved draft' } },
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(mockHub.request).toHaveBeenCalledWith('session.get', { sessionId: 'session-1' });
      expect(result.current.content).toBe('Saved draft');
    });

    it('should not load draft when hub is not connected', async () => {
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);

      const { result } = renderHook(() => useInputDraft('session-1'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(mockHub.request).not.toHaveBeenCalled();
      expect(result.current.content).toBe('');
    });

    it('should handle load error gracefully', async () => {
      mockHub.request.mockRejectedValue(new Error('Network error'));
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.content).toBe('');
    });

    it('should handle session with no draft metadata', async () => {
      mockHub.request.mockResolvedValue({
        session: { metadata: {} },
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.content).toBe('');
    });

    it('should handle session with null metadata', async () => {
      mockHub.request.mockResolvedValue({
        session: {},
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.content).toBe('');
    });
  });

  describe('debounced saving', () => {
    it('should save draft after debounce delay', async () => {
      mockHub.request.mockResolvedValue({});
      mockHub.request.mockResolvedValue({});
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1', 100));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      mockHub.request.mockClear();

      act(() => {
        result.current.setContent('New content');
      });

      const callsBeforeDebounce = mockHub.request.mock.calls.filter(
        (call) => call[0] === 'session.update' && call[1]?.metadata?.inputDraft === 'New content'
      );
      expect(callsBeforeDebounce.length).toBe(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });

      expect(mockHub.request).toHaveBeenCalledWith('session.update', {
        sessionId: 'session-1',
        metadata: { inputDraft: 'New content' },
      });
    });

    it('should clear draft immediately when content is empty', async () => {
      mockHub.request.mockResolvedValue({});
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      act(() => {
        result.current.setContent('Some content');
      });

      act(() => {
        result.current.setContent('');
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(mockHub.request).toHaveBeenCalledWith('session.clearInputDraftIf', {
        sessionId: 'session-1',
        expected: 'Some content',
      });
      expect(mockHub.request).toHaveBeenCalledWith('session.update', {
        sessionId: 'session-1',
        metadata: { inputDraft: null },
      });
    });

    it('should handle save error gracefully', async () => {
      mockHub.request.mockResolvedValue({});
      mockHub.request.mockRejectedValue(new Error('Save error'));
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1', 100));

      act(() => {
        result.current.setContent('Content');
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
    });

    it('should cancel pending save when new content is set', async () => {
      mockHub.request.mockResolvedValue({});
      mockHub.request.mockResolvedValue({});
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1', 100));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      mockHub.request.mockClear();

      act(() => {
        result.current.setContent('First');
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      act(() => {
        result.current.setContent('Second');
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });

      const updateCalls = mockHub.request.mock.calls.filter(
        (call) => call[0] === 'session.update' && call[1]?.metadata?.inputDraft
      );
      expect(updateCalls).toEqual([
        ['session.update', { sessionId: 'session-1', metadata: { inputDraft: 'Second' } }],
      ]);
    });

    it('should clear existing timeout when content changes rapidly', async () => {
      mockHub.request.mockResolvedValue({});
      mockHub.request.mockResolvedValue({});
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1', 200));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      mockHub.request.mockClear();

      act(() => {
        result.current.setContent('H');
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      act(() => {
        result.current.setContent('He');
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      act(() => {
        result.current.setContent('Hel');
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      act(() => {
        result.current.setContent('Hell');
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      const updateCalls = mockHub.request.mock.calls.filter(
        (call) => call[0] === 'session.update' && call[1]?.metadata?.inputDraft
      );
      expect(updateCalls).toEqual([
        ['session.update', { sessionId: 'session-1', metadata: { inputDraft: 'Hell' } }],
      ]);
    });

    it('should trim content before saving', async () => {
      mockHub.request.mockResolvedValue({});
      mockHub.request.mockResolvedValue({});
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1', 100));

      act(() => {
        result.current.setContent('  Content with spaces  ');
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });

      expect(mockHub.request).toHaveBeenCalledWith('session.update', {
        sessionId: 'session-1',
        metadata: { inputDraft: 'Content with spaces' },
      });
    });

    it('should clear draft when content is only whitespace', async () => {
      mockHub.request.mockResolvedValue({});
      mockHub.request.mockResolvedValue({});
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      act(() => {
        result.current.setContent('   ');
      });

      expect(mockHub.request).toHaveBeenCalledWith('session.update', {
        sessionId: 'session-1',
        metadata: { inputDraft: null },
      });
    });

    it('does not send the mount-time empty clear before the initial load settles', async () => {
      let resolveGet!: (value: unknown) => void;
      mockHub.request.mockImplementation(() => {
        let resolve!: (value: unknown) => void;
        const promise = new Promise((r) => {
          resolve = r;
        });
        resolveGet = resolve;
        return promise;
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      renderHook(() => useInputDraft('session-1'));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(mockHub.request).not.toHaveBeenCalledWith('session.update', {
        sessionId: 'session-1',
        metadata: { inputDraft: null },
      });

      await act(async () => {
        resolveGet({ session: { metadata: { inputDraft: 'saved' } } });
        await vi.runAllTimersAsync();
      });
      expect(mockHub.request).not.toHaveBeenCalledWith('session.update', {
        sessionId: 'session-1',
        metadata: { inputDraft: null },
      });
    });

    it('re-arms the load guard when revisiting a session (A -> B -> A)', async () => {
      const gets: Array<{ resolve: (value: unknown) => void }> = [];
      mockHub.request.mockImplementation(() => {
        let resolve!: (value: unknown) => void;
        const promise = new Promise((r) => {
          resolve = r;
        });
        gets.push({ resolve });
        return promise;
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId), {
        initialProps: { sessionId: 'session-A' },
      });

      await act(async () => {
        gets[0]?.resolve({ session: { metadata: { inputDraft: 'a-draft' } } });
        await vi.runAllTimersAsync();
      });

      rerender({ sessionId: 'session-B' });
      rerender({ sessionId: 'session-A' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const clearCalls = mockHub.request.mock.calls.filter(
        (call) => call[0] === 'session.update' && call[1]?.metadata?.inputDraft === null
      );
      expect(clearCalls).toEqual([]);
    });

    it('retries an explicit draft deletion via the switch flush when the clear failed', async () => {
      let deletionRejected = false;
      mockHub.request.mockImplementation(async (method: string, payload: unknown) => {
        if (method === 'session.get')
          return { session: { metadata: { inputDraft: 'loaded draft' } } };
        const meta = (payload as { metadata?: { inputDraft?: string | null } })?.metadata;
        if (method === 'session.update' && meta && meta.inputDraft === null && !deletionRejected) {
          deletionRejected = true;
          throw new Error('offline');
        }
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result, rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId), {
        initialProps: { sessionId: 'session-A' },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('loaded draft');
      act(() => {
        result.current.setContent('');
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      mockHub.request.mockClear();

      rerender({ sessionId: 'session-B' });
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(mockHub.request).toHaveBeenCalledWith('session.update', {
        sessionId: 'session-A',
        metadata: { inputDraft: null },
      });
    });

    it('does not retry a deletion that was already confirmed', async () => {
      mockHub.request.mockResolvedValue({
        session: { metadata: { inputDraft: 'loaded draft' } },
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result, rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId), {
        initialProps: { sessionId: 'session-A' },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });
      act(() => {
        result.current.setContent('');
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      mockHub.request.mockClear();

      rerender({ sessionId: 'session-B' });
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const nullClears = mockHub.request.mock.calls.filter(
        (call) => call[0] === 'session.update' && call[1]?.metadata?.inputDraft === null
      );
      expect(nullClears).toEqual([]);
    });

    it('should handle clear error gracefully', async () => {
      mockHub.request.mockResolvedValue({});
      mockHub.request.mockRejectedValue(new Error('Clear error'));
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));

      act(() => {
        result.current.setContent('');
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });
    });
  });

  describe('session switch behavior', () => {
    it('should call session.update when switching sessions', async () => {
      mockHub.request.mockResolvedValue({});
      mockHub.request.mockResolvedValue({});
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result, rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId, 100), {
        initialProps: { sessionId: 'session-1' },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      act(() => {
        result.current.setContent('Content for session 1');
      });

      rerender({ sessionId: 'session-2' });

      const updateCalls = mockHub.request.mock.calls.filter((call) => call[0] === 'session.update');
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    it('should handle flush error gracefully', async () => {
      mockHub.request.mockResolvedValue({});
      mockHub.request.mockRejectedValue(new Error('Flush error'));
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result, rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId), {
        initialProps: { sessionId: 'session-1' },
      });

      act(() => {
        result.current.setContent('Content to flush');
      });

      rerender({ sessionId: 'session-2' });

      await act(async () => {
        await vi.runAllTimersAsync();
      });
    });

    it('should not call hub when not connected', async () => {
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);

      const { result, rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId), {
        initialProps: { sessionId: 'session-1' },
      });

      act(() => {
        result.current.setContent('Content');
      });

      rerender({ sessionId: 'session-2' });

      expect(mockHub.request).not.toHaveBeenCalled();
    });

    it('should clear content when session changes', async () => {
      mockHub.request.mockResolvedValue({});
      mockHub.request.mockResolvedValue({});
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result, rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId), {
        initialProps: { sessionId: 'session-1' },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      act(() => {
        result.current.setContent('Content');
      });

      expect(result.current.content).toBe('Content');

      rerender({ sessionId: 'session-2' });

      expect(result.current.content).toBe('');
    });
  });

  describe('cleanup', () => {
    it('should cleanup timeouts on unmount', async () => {
      mockHub.request.mockResolvedValue({});
      mockHub.request.mockResolvedValue({});
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result, unmount } = renderHook(() => useInputDraft('session-1', 100));

      act(() => {
        result.current.setContent('Content');
      });

      unmount();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });

      expect(mockHub.request).not.toHaveBeenCalledWith('session.update', {
        sessionId: 'session-1',
        metadata: { inputDraft: 'Content' },
      });
    });
  });

  describe('voiceLanded adoption (daemon-coordinated)', () => {
    const captureListener = () => {
      const calls = mockHub.onEvent.mock.calls.filter(([m]) => m === 'session.voiceLanded');
      expect(calls.length).toBeGreaterThan(0);
      return calls[calls.length - 1][1];
    };

    it('adopts the composition into an empty composer and saves it immediately', async () => {
      let gets = 0;
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          gets += 1;
          return {
            session: { metadata: { inputDraft: gets === 1 ? '' : 'typed voice words' } },
          };
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('');
      const listener = captureListener();
      act(() => {
        listener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
      });
      await act(async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      const saves = mockHub.request.mock.calls.filter(
        ([m, d]) => m === 'session.update' && d?.metadata?.inputDraft === 'typed voice words'
      );
      expect(saves.length).toBeGreaterThanOrEqual(1);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('typed voice words');
    });

    it('adopts over a composer that still shows the last-read draft', async () => {
      let gets = 0;
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          gets += 1;
          return {
            session: { metadata: { inputDraft: gets === 1 ? 'plain draft' : 'plain draft voice' } },
          };
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('plain draft');
      const listener = captureListener();
      act(() => {
        listener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('plain draft voice');
    });

    it('never clobbers a composer with user typing', async () => {
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return { session: { metadata: { inputDraft: 'server composition' } } };
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      act(() => {
        result.current.setContent('user is typing');
      });
      const listener = captureListener();
      const getsBefore = mockHub.request.mock.calls.filter(([m]) => m === 'session.get').length;
      act(() => {
        listener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('user is typing');
      const gets = mockHub.request.mock.calls.filter(([m]) => m === 'session.get');
      expect(gets.length).toBe(getsBefore);
    });

    it('skips the immediate adoption save when typing begins mid-get', async () => {
      const pending: Array<(v: unknown) => void> = [];
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return new Promise((resolve) => {
            pending.push(resolve);
          });
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        pending.shift()?.({ session: { metadata: { inputDraft: '' } } });
        await vi.runAllTimersAsync();
      });
      const listener = captureListener();
      act(() => {
        listener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      act(() => {
        result.current.setContent('fresh keystrokes');
      });
      await act(async () => {
        pending.shift()?.({ session: { metadata: { inputDraft: 'composition' } } });
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('fresh keystrokes');
      const saves = mockHub.request.mock.calls.filter(
        ([m, d]) => m === 'session.update' && d?.metadata?.inputDraft === 'composition'
      );
      expect(saves).toHaveLength(0);
    });

    it('ignores voiceLanded events for other sessions', async () => {
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return { session: { metadata: { inputDraft: 'session-1 draft' } } };
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const listener = captureListener();
      const getsBefore = mockHub.request.mock.calls.filter(([m]) => m === 'session.get').length;
      act(() => {
        listener({ sessionId: 'session-2' }, { channel: 'session:session-2' });
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('session-1 draft');
      expect(mockHub.request.mock.calls.filter(([m]) => m === 'session.get').length).toBe(
        getsBefore
      );
    });

    it('does not adopt a stale refresh after the session changed', async () => {
      const pending: Array<(v: unknown) => void> = [];
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return new Promise((resolve) => {
            pending.push(resolve);
          });
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result, rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId), {
        initialProps: { sessionId: 'session-1' },
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        pending.shift()?.({ session: { metadata: { inputDraft: '' } } });
        await vi.runAllTimersAsync();
      });
      const listener = captureListener();
      act(() => {
        listener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      rerender({ sessionId: 'session-2' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      await act(async () => {
        pending.shift()?.({ session: { metadata: { inputDraft: 'old session draft' } } });
        pending.shift()?.({ session: { metadata: { inputDraft: '' } } });
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('');
    });

    it('re-subscribes when the connection cycles', async () => {
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return { session: { metadata: { inputDraft: 'composed' } } };
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        connectionState.value = 'disconnected';
        connectionState.value = 'connected';
        await vi.advanceTimersByTimeAsync(50);
      });
      const registrations = mockHub.onEvent.mock.calls.filter(([m]) => m === 'session.voiceLanded');
      expect(registrations.length).toBeGreaterThanOrEqual(2);
      const listener = registrations[registrations.length - 1][1];
      act(() => {
        listener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('composed');
    });

    it('leaves the composer untouched when the refresh get fails', async () => {
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return { session: { metadata: { inputDraft: 'loaded draft' } } };
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('loaded draft');
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') throw new Error('transient');
        return { success: true };
      });
      const listener = captureListener();
      act(() => {
        listener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('loaded draft');
      const foreign = mockHub.request.mock.calls.filter(
        ([m, d]) => m === 'session.update' && d?.metadata?.inputDraft !== 'loaded draft'
      );
      expect(foreign).toHaveLength(0);
    });

    it('never lets a stale pre-adoption debounced save regress the server past the adoption save', async () => {
      let gets = 0;
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          gets += 1;
          return {
            session: {
              metadata: { inputDraft: gets === 1 ? 'plain draft' : 'plain draft voice' },
            },
          };
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1', 20));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.content).toBe('plain draft');

      const listener = captureListener();
      await act(async () => {
        listener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
        await vi.advanceTimersByTimeAsync(25);
      });
      expect(result.current.content).toBe('plain draft voice');

      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const updates = mockHub.request.mock.calls
        .filter(([m]) => m === 'session.update')
        .map(([, d]) => d?.metadata?.inputDraft);
      const adoptedAt = updates.indexOf('plain draft voice');
      expect(adoptedAt).toBeGreaterThanOrEqual(0);
      expect(updates.slice(adoptedAt + 1)).not.toContain('plain draft');
    });

    it('discards a stale initial load that resolves after an adoption', async () => {
      const pending: Array<(v: unknown) => void> = [];
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return new Promise((resolve) => {
            pending.push(resolve);
          });
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      const listener = captureListener();
      act(() => {
        listener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      await act(async () => {
        pending[1]?.({ session: { metadata: { inputDraft: 'plain draft voice' } } });
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(result.current.content).toBe('plain draft voice');
      await act(async () => {
        pending[0]?.({ session: { metadata: { inputDraft: 'plain draft' } } });
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('plain draft voice');
      const updates = mockHub.request.mock.calls
        .filter(([m]) => m === 'session.update')
        .map(([, d]) => d?.metadata?.inputDraft);
      const adoptedAt = updates.indexOf('plain draft voice');
      expect(adoptedAt).toBeGreaterThanOrEqual(0);
      expect(updates.slice(adoptedAt + 1)).not.toContain('plain draft');
    });

    it('stops listening for voiceLanded after unmount', async () => {
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return { session: { metadata: { inputDraft: 'draft' } } };
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
      const unsubSpy = vi.fn();
      mockHub.onEvent.mockImplementation(() => unsubSpy);

      const { unmount } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const registrationsBefore = mockHub.onEvent.mock.calls.filter(
        ([m]) => m === 'session.voiceLanded'
      ).length;
      expect(registrationsBefore).toBeGreaterThan(0);
      unmount();
      expect(unsubSpy).toHaveBeenCalled();
      await act(async () => {
        connectionState.value = 'disconnected';
        connectionState.value = 'connected';
        await vi.runAllTimersAsync();
      });
      expect(mockHub.onEvent.mock.calls.filter(([m]) => m === 'session.voiceLanded').length).toBe(
        registrationsBefore
      );
    });

    it('stops listening for the previous session after a session switch', async () => {
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return { session: { metadata: { inputDraft: 'draft' } } };
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { rerender } = renderHook(({ id }) => useInputDraft(id), {
        initialProps: { id: 'session-1' },
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const staleListener = captureListener();
      await act(async () => {
        rerender({ id: 'session-2' });
        await vi.runAllTimersAsync();
      });
      const session1Gets = () =>
        mockHub.request.mock.calls.filter(
          ([m, d]) => m === 'session.get' && d?.sessionId === 'session-1'
        ).length;
      const before = session1Gets();
      act(() => {
        staleListener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(session1Gets()).toBe(before);
    });

    it('surfaces a skipped landing when the typing composer empties', async () => {
      let gets = 0;
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          gets += 1;
          return {
            session: {
              metadata: { inputDraft: gets === 1 ? 'typed so far' : 'typed so far voice' },
            },
          };
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('typed so far');
      act(() => {
        result.current.setContent('more typing');
      });
      const getsBefore = mockHub.request.mock.calls.filter(([m]) => m === 'session.get').length;
      const listener = captureListener();
      act(() => {
        listener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(mockHub.request.mock.calls.filter(([m]) => m === 'session.get').length).toBe(
        getsBefore
      );
      act(() => {
        result.current.setContent('');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(result.current.content).toBe('typed so far voice');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const saves = mockHub.request.mock.calls.filter(
        ([m, d]) => m === 'session.update' && d?.metadata?.inputDraft === 'typed so far voice'
      );
      expect(saves.length).toBeGreaterThanOrEqual(1);
    });

    it('retries a failed adoption refresh once on the next connection transition', async () => {
      let gets = 0;
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          gets += 1;
          if (gets === 2) throw new Error('dropped socket');
          return {
            session: { metadata: { inputDraft: gets === 1 ? 'draft' : 'draft voice' } },
          };
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('draft');
      const listener = captureListener();
      act(() => {
        listener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('draft');
      await act(async () => {
        connectionState.value = 'disconnected';
        connectionState.value = 'connected';
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('draft voice');
      const saves = mockHub.request.mock.calls.filter(
        ([m, d]) => m === 'session.update' && d?.metadata?.inputDraft === 'draft voice'
      );
      expect(saves.length).toBeGreaterThanOrEqual(1);
    });

    it('keeps the adopted composition and re-issues it debounced when the immediate save rejects', async () => {
      let gets = 0;
      let compositionSaveFailed = false;
      mockHub.request.mockImplementation(
        async (method: string, data?: { metadata?: { inputDraft?: string } }) => {
          if (method === 'session.get') {
            gets += 1;
            return {
              session: { metadata: { inputDraft: gets === 1 ? '' : 'composed draft' } },
            };
          }
          if (method === 'session.update' && data?.metadata?.inputDraft === 'composed draft') {
            if (!compositionSaveFailed) {
              compositionSaveFailed = true;
              throw new Error('transient');
            }
          }
          return { success: true };
        }
      );
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const listener = captureListener();
      act(() => {
        listener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
      });
      await act(async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      expect(result.current.content).toBe('composed draft');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const saves = mockHub.request.mock.calls.filter(
        ([m, d]) => m === 'session.update' && d?.metadata?.inputDraft === 'composed draft'
      );
      expect(saves.length).toBeGreaterThanOrEqual(2);
    });

    it('skips a due debounced save whose armed value the signal has advanced past', async () => {
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return { session: { metadata: { inputDraft: '' } } };
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1', 20));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      act(() => {
        result.current.setContent('first text');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        result.current.setContent('second text');
        await vi.advanceTimersByTimeAsync(30);
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const updates = mockHub.request.mock.calls
        .filter(([m]) => m === 'session.update')
        .map(([, d]) => d?.metadata?.inputDraft);
      expect(updates).not.toContain('first text');
      expect(updates).toContain('second text');
    });

    it('never clobbers typing that began while the initial load was in flight', async () => {
      const pendingResolvers: Array<(v: unknown) => void> = [];
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return new Promise((resolve) => {
            pendingResolvers.push(resolve);
          });
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      act(() => {
        result.current.setContent('fresh keystrokes');
      });
      await act(async () => {
        pendingResolvers[0]?.({ session: { metadata: { inputDraft: 'server draft' } } });
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('fresh keystrokes');
      const updates = mockHub.request.mock.calls
        .filter(([m]) => m === 'session.update')
        .map(([, d]) => d?.metadata?.inputDraft);
      expect(updates).not.toContain('server draft');
      expect(updates).toContain('fresh keystrokes');
    });

    it('routes an in-debounce typing clear through clearInputDraftIf and never writes the staging field', async () => {
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return { session: { metadata: { inputDraft: '' } } };
        }
        if (method === 'session.clearInputDraftIf') return { cleared: false };
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      act(() => {
        result.current.setContent('hello');
      });
      act(() => {
        result.current.setContent('');
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(mockHub.request).toHaveBeenCalledWith('session.clearInputDraftIf', {
        sessionId: 'session-1',
        expected: 'hello',
      });
      expect(mockHub.request).toHaveBeenCalledWith('session.update', {
        sessionId: 'session-1',
        metadata: { inputDraft: null },
      });
      const stagingWrites = mockHub.request.mock.calls.filter(
        ([m, d]) => m === 'session.update' && 'inputDraftVoicePending' in (d?.metadata ?? {})
      );
      expect(stagingWrites).toHaveLength(0);
    });

    it('discards a displayed voice composition atomically and skips the bare typing clear', async () => {
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return {
            session: { metadata: { inputDraft: 'voice', inputDraftVoicePending: 'voice' } },
          };
        }
        if (method === 'session.clearInputDraftIf') return { cleared: true };
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('voice');
      act(() => {
        result.current.setContent('');
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(mockHub.request).toHaveBeenCalledWith('session.clearInputDraftIf', {
        sessionId: 'session-1',
        expected: 'voice',
      });
      expect(mockHub.request).not.toHaveBeenCalledWith('session.update', {
        sessionId: 'session-1',
        metadata: { inputDraft: null },
      });
    });

    it('re-arms the one-shot when the composition exceeds the character limit', async () => {
      const rawDraft = 'x'.repeat(50);
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return {
            session: { metadata: { inputDraft: rawDraft, inputDraftVoicePending: 'voice words' } },
          };
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const gets = () => mockHub.request.mock.calls.filter(([m]) => m === 'session.get').length;
      const getsAfterLoad = gets();
      const listener = captureListener();
      act(() => {
        listener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
      });
      await act(async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      expect(result.current.content).toBe(rawDraft);
      const rawSaves = mockHub.request.mock.calls.filter(
        ([m, d]) => m === 'session.update' && d?.metadata?.inputDraft === rawDraft
      );
      expect(rawSaves).toHaveLength(0);
      expect(gets()).toBe(getsAfterLoad + 1);
      act(() => {
        result.current.setContent('');
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(gets()).toBe(getsAfterLoad + 2);
    });

    it('re-arms the one-shot when the immediate adoption save rejects', async () => {
      let gets = 0;
      let compositionSaves = 0;
      mockHub.request.mockImplementation(
        async (method: string, data?: { metadata?: { inputDraft?: string } }) => {
          if (method === 'session.get') {
            gets += 1;
            return {
              session: {
                metadata:
                  gets === 1
                    ? { inputDraft: '' }
                    : { inputDraft: 'draft voice', inputDraftVoicePending: 'voice' },
              },
            };
          }
          if (method === 'session.update' && data?.metadata?.inputDraft === 'draft voice') {
            compositionSaves += 1;
            if (compositionSaves === 1) throw new Error('transient');
          }
          return { success: true };
        }
      );
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const listener = captureListener();
      act(() => {
        listener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
      });
      await act(async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      expect(result.current.content).toBe('draft voice');
      act(() => {
        result.current.setContent('');
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('draft voice');
      const saves = mockHub.request.mock.calls.filter(
        ([m, d]) => m === 'session.update' && d?.metadata?.inputDraft === 'draft voice'
      );
      expect(saves.length).toBeGreaterThanOrEqual(2);
      expect(gets).toBe(3);
    });
    it('never adopts into a submission-held empty composer; a failed send restores over an intact staging', async () => {
      let gets = 0;
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          gets += 1;
          return {
            session: {
              metadata: { inputDraft: 'hello voice', inputDraftVoicePending: 'voice' },
            },
          };
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      act(() => {
        result.current.setContent('hello');
      });
      const listener = captureListener();
      act(() => {
        listener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      const getsAfterLanding = gets;

      let resolveSend: () => void = () => {};
      const sendSettled = new Promise<void>((resolve) => {
        resolveSend = resolve;
      });
      let held: Promise<void> = Promise.resolve();
      act(() => {
        held = result.current.holdDraftAdoption(async () => {
          result.current.clear();
          await sendSettled;
          result.current.setContent('hello');
        });
      });
      await act(async () => {
        resolveSend();
        await held;
        await vi.runAllTimersAsync();
      });

      expect(gets).toBe(getsAfterLanding);
      expect(result.current.content).toBe('hello');
      const compositionSaves = mockHub.request.mock.calls.filter(
        ([m, d]) => m === 'session.update' && d?.metadata?.inputDraft === 'hello voice'
      );
      expect(compositionSaves).toHaveLength(0);

      act(() => {
        result.current.clear();
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('hello voice');
      expect(gets).toBe(getsAfterLanding + 1);
    });

    it('re-arms the one-shot when typing rejects the INITIAL load that carried a staging', async () => {
      const pendingResolvers: Array<(v: unknown) => void> = [];
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return new Promise((resolve) => {
            pendingResolvers.push(resolve);
          });
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      act(() => {
        result.current.setContent('fresh typing');
      });
      await act(async () => {
        pendingResolvers[0]?.({
          session: {
            metadata: { inputDraft: 'stale draft voice', inputDraftVoicePending: 'voice' },
          },
        });
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(result.current.content).toBe('fresh typing');
      const staleSaves = mockHub.request.mock.calls.filter(
        ([m, d]) => m === 'session.update' && d?.metadata?.inputDraft === 'stale draft voice'
      );
      expect(staleSaves).toHaveLength(0);

      act(() => {
        result.current.setContent('');
      });
      await act(async () => {
        pendingResolvers[1]?.({
          session: {
            metadata: { inputDraft: 'stale draft voice', inputDraftVoicePending: 'voice' },
          },
        });
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('stale draft voice');
      const saves = mockHub.request.mock.calls.filter(
        ([m, d]) => m === 'session.update' && d?.metadata?.inputDraft === 'stale draft voice'
      );
      expect(saves.length).toBeGreaterThanOrEqual(1);
    });

    it('arms the one-shot when the INITIAL load applies an over-limit raw draft over a staging', async () => {
      const rawDraft = 'x'.repeat(50);
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return {
            session: { metadata: { inputDraft: rawDraft, inputDraftVoicePending: 'voice words' } },
          };
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe(rawDraft);
      const gets = () => mockHub.request.mock.calls.filter(([m]) => m === 'session.get').length;
      const getsAfterLoad = gets();
      act(() => {
        result.current.setContent('');
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(gets()).toBe(getsAfterLoad + 1);
    });

    it('surfaces a deferred staging after a successful submit releases the hold', async () => {
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return {
            session: {
              metadata: { inputDraft: 'hello voice', inputDraftVoicePending: 'voice' },
            },
          };
        }
        return { success: true };
      });
      connectionState.value = 'connected';
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      act(() => {
        result.current.setContent('hello');
      });
      const listener = captureListener();
      act(() => {
        listener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      let resolveSend: () => void = () => {};
      const sendSettled = new Promise<void>((resolve) => {
        resolveSend = resolve;
      });
      let held: Promise<void> = Promise.resolve();
      act(() => {
        held = result.current.holdDraftAdoption(async () => {
          result.current.clear();
          await sendSettled;
        });
      });
      await act(async () => {
        resolveSend();
        await held;
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('hello voice');
      const saves = mockHub.request.mock.calls.filter(
        ([m, d]) => m === 'session.update' && d?.metadata?.inputDraft === 'hello voice'
      );
      expect(saves.length).toBeGreaterThanOrEqual(1);
    });
  });
});

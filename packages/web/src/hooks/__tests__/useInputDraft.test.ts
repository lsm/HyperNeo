// @ts-nocheck
/**
 * Tests for useInputDraft Hook
 *
 * Tests draft persistence, debounced saving, and content management.
 * Uses Preact Signals internally to prevent lost keystrokes.
 * Note: Tests that require connection mocking are limited due to module initialization order.
 */

import { renderHook, act } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useInputDraft } from '../useInputDraft.ts';
import { connectionManager } from '../../lib/connection-manager.ts';
import { connectionState } from '../../lib/state.ts';
import { resetVoiceTranscriptOutbox } from '../../lib/voice/voice-transcript-outbox.ts';

// Mock the connection manager
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
    // Current unified API
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
    // Default: no hub connected
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

      // Should not throw
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

      // Switch session
      rerender({ sessionId: 'session-2' });

      // Content should be cleared immediately
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

      // Rapid switches
      rerender({ sessionId: 'session-2' });
      rerender({ sessionId: 'session-3' });
      rerender({ sessionId: 'session-4' });

      // Content should be empty after rapid switches
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
      // Should not throw
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

      // Accessing content multiple times should return same value
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

      // Wait for async draft loading
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

      // Wait for initial effects to run
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Clear mock calls from initialization
      mockHub.request.mockClear();

      act(() => {
        result.current.setContent('New content');
      });

      // Should not save immediately (need to check specifically for this content)
      const callsBeforeDebounce = mockHub.request.mock.calls.filter(
        (call) => call[0] === 'session.update' && call[1]?.metadata?.inputDraft === 'New content'
      );
      expect(callsBeforeDebounce.length).toBe(0);

      // Advance timer past debounce delay
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

      // Let the initial draft load settle — the transient pre-load '' must not
      // trigger the immediate clear (it would wipe the server-side draft).
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      act(() => {
        result.current.setContent('Some content');
      });

      // Clear content
      act(() => {
        result.current.setContent('');
      });

      // The composer last showed 'Some content', so the clear first offers the
      // daemon the composition-aware clearInputDraftIf; the mock answers
      // without `cleared`, so the unconditional typing-clear follows.
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(mockHub.request).toHaveBeenCalledWith('session.clearInputDraftIf', {
        sessionId: 'session-1',
        expected: 'Some content',
      });
      // Should save immediately with null (undefined is dropped by JSON-RPC serialization)
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

      // Error should be handled gracefully (no throw)
    });

    it('should cancel pending save when new content is set', async () => {
      mockHub.request.mockResolvedValue({});
      mockHub.request.mockResolvedValue({});
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1', 100));

      // Wait for initial effects
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      mockHub.request.mockClear();

      // Set content - this schedules a timeout
      act(() => {
        result.current.setContent('First');
      });

      // Advance partially (timeout not yet fired)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // Set new content - this should clear the existing pending timeout (lines 94-95)
      act(() => {
        result.current.setContent('Second');
      });

      // Advance past original debounce
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });

      // Should only have saved 'Second', not 'First'
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

      // Wait for initial effects
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      mockHub.request.mockClear();

      // Simulate rapid typing - each call should cancel the previous pending save
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

      // Wait for final debounce to complete
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      // Should only save the final content
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

      // Should clear immediately
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

      // The initial load is still in flight and the signal is transiently ''.
      // The save effect must NOT clear the server-side draft in that window.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(mockHub.request).not.toHaveBeenCalledWith('session.update', {
        sessionId: 'session-1',
        metadata: { inputDraft: null },
      });

      // Once the load settles, subsequent user deletions clear normally.
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
      // Each session.get gets its own deferred so we control resolution order.
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

      // A's first load settles (marker = A).
      await act(async () => {
        gets[0]?.resolve({ session: { metadata: { inputDraft: 'a-draft' } } });
        await vi.runAllTimersAsync();
      });

      // Switch to B (get pending), then back to A (get pending). The stale
      // marker for A must have been invalidated — no empty-clear may fire for
      // A while its fresh get is in flight.
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
      // First null-clear (the user's deletion) fails; later calls succeed.
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
      // Let the (failing) immediate clear settle — the retry marker stays.
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      mockHub.request.mockClear();

      // Switch away — the flush retries inputDraft: null for session-A because
      // the deletion was never confirmed.
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
      // The immediate clear SUCCEEDS — the retry marker is dropped.
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      mockHub.request.mockClear();

      rerender({ sessionId: 'session-B' });
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // No flush retry: a newer draft saved elsewhere must survive.
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

      // Error should be handled gracefully (no throw)
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

      // Wait for initial effects to run
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      act(() => {
        result.current.setContent('Content for session 1');
      });

      // Switch session
      rerender({ sessionId: 'session-2' });

      // Should have made session.update calls (flush and/or clear)
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

      // Set content first so there's something to flush
      act(() => {
        result.current.setContent('Content to flush');
      });

      // Switch session to trigger flush
      rerender({ sessionId: 'session-2' });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Error should be handled gracefully (no throw)
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

      // Wait for initial effects to run
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      act(() => {
        result.current.setContent('Content');
      });

      expect(result.current.content).toBe('Content');

      rerender({ sessionId: 'session-2' });

      // Content should be cleared on session switch
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

      // Unmount before debounce fires
      unmount();

      // Advance timers - should not throw or save
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });

      // Should not have saved (was unmounted)
      expect(mockHub.request).not.toHaveBeenCalledWith('session.update', {
        sessionId: 'session-1',
        metadata: { inputDraft: 'Content' },
      });
    });
  });

  describe('voiceLanded adoption (daemon-coordinated)', () => {
    // The daemon announces every committed session.appendVoiceDraft on the
    // session channel; the hook's listener re-reads and adopts the composed
    // draft (typing + staged transcript) into an idle-or-unchanged composer,
    // then saves the composition IMMEDIATELY so the daemon's adoption rule
    // consumes the staging in one write.
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
      // Flush ONLY microtasks — no timer advancement: the adoption save must
      // already have been issued from the refresh's resolve path, without
      // waiting for the 250ms debounce. A debounced-only implementation (the
      // immediate save removed) cannot pass: nothing fires without timers.
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
      // The composed draft is adopted…
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
      // Unchanged since the load (no user edits) — the refresh adopts.
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
      // Typing is never overwritten, and no refresh get was even issued: the
      // staged transcript is durable server-side and converges later.
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
      // get #1 (initial load) resolves empty so the composer is idle.
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
      // The user starts typing WHILE the refresh get is in flight.
      act(() => {
        result.current.setContent('fresh keystrokes');
      });
      await act(async () => {
        pending.shift()?.({ session: { metadata: { inputDraft: 'composition' } } });
        await vi.runAllTimersAsync();
      });
      // The typing survives — the response was not applied over it…
      expect(result.current.content).toBe('fresh keystrokes');
      // …and no adoption save pushed the composition over it.
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
      // get #1 (session-1 initial load) resolves so the composer is idle.
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
      // The hook moved to another session while the refresh get hung.
      rerender({ sessionId: 'session-2' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      await act(async () => {
        // get #2 (the stale refresh) and get #3 (session-2's initial load).
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
      // The listener was re-registered on the (mock) hub after the cycle.
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
      // A failed refresh changes nothing; the staged transcript stays
      // server-side and converges on a later trigger. (The loaded draft's own
      // debounced round-trip save is legitimate pre-existing behavior.)
      expect(result.current.content).toBe('loaded draft');
      const foreign = mockHub.request.mock.calls.filter(
        ([m, d]) => m === 'session.update' && d?.metadata?.inputDraft !== 'loaded draft'
      );
      expect(foreign).toHaveLength(0);
    });

    it('never lets a stale pre-adoption debounced save regress the server past the adoption save', async () => {
      // The save effect (which cancels the armed debounce) is rAF-deferred.
      // When a pre-adoption timer comes due in the frame gap after the
      // immediate adoption save, its write would regress the server to the
      // OLD draft — past a staging the adoption save already consumed
      // (deterministic in a hidden tab, where rAF is suspended but clamped
      // timers still fire). The gap is simulated inside ONE act(): act
      // flushes deferred effects only at its END, so a debounce timer that
      // fires within the act callback runs while its cancelling effect is
      // still queued.
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
      // The initial load applies and the (act-end flushed) effect arms the
      // debounced save for the loaded draft, due 20ms later.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.content).toBe('plain draft');

      // One act: the landing fires, the refresh adopts and saves the
      // composition IMMEDIATELY, and — before the act's end flush can cancel
      // it — the armed pre-adoption timer comes due and fires.
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
      // …and no stale write of the OLD draft landed after the adoption save.
      expect(updates.slice(adoptedAt + 1)).not.toContain('plain draft');
    });

    it('discards a stale initial load that resolves after an adoption', async () => {
      // The mount-time get and a voiceLanded refresh can be in flight
      // together; responses may reorder. The refresh adopting first must be
      // final: the stale pre-transcript response must not regress the
      // composer (whose debounced save would then durably overwrite the
      // composition the adoption save already consumed).
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
      // get #1 (initial load) hangs; a landing triggers get #2 (refresh).
      const listener = captureListener();
      act(() => {
        listener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      // The REFRESH resolves first with the composition: adopted and saved
      // immediately, consuming the staging daemon-side.
      await act(async () => {
        pending[1]?.({ session: { metadata: { inputDraft: 'plain draft voice' } } });
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(result.current.content).toBe('plain draft voice');
      // The stale initial get resolves LAST with the pre-transcript draft…
      await act(async () => {
        pending[0]?.({ session: { metadata: { inputDraft: 'plain draft' } } });
        await vi.runAllTimersAsync();
      });
      // …and must neither regress the composer nor re-persist the old draft
      // over the adopted composition.
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
      // The hub subscription was torn down with the hook…
      expect(unsubSpy).toHaveBeenCalled();
      // …and no later connection cycle re-registers it (the re-arm
      // subscription is torn down too — without it every cycle after N
      // switches would leak one more hub listener).
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
      // A landing for the OLD session, delivered to the OLD listener, must
      // not issue a refresh get against session-1.
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
      // A landing that arrives while the user types defers (never clobbers);
      // the one-shot re-check surfaces it when the composer next empties —
      // the pre-PR client's deferred surfacing parity.
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
      // The user keeps typing; a landing arrives and is deferred — no refresh.
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
      // The composer empties (a send or clear): the deferred landing surfaces.
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
      // The refresh get failed on a dropped socket; the landing event is gone,
      // so nothing else would retry without the one-shot marker.
      expect(result.current.content).toBe('draft');
      // The next connection transition retries once and adopts.
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
      // Microtask flush: the adoption applied and its IMMEDIATE save was
      // issued (and rejected — swallowed).
      await act(async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      expect(result.current.content).toBe('composed draft');
      // The debounced save effect re-arms for the adopted value and re-issues
      // it — the recovery the catch comment claims.
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const saves = mockHub.request.mock.calls.filter(
        ([m, d]) => m === 'session.update' && d?.metadata?.inputDraft === 'composed draft'
      );
      expect(saves.length).toBeGreaterThanOrEqual(2);
    });

    it('skips a due debounced save whose armed value the signal has advanced past', async () => {
      // The timer-skip arm of the stale-save defense, in isolation (no
      // adoption involved): a timer armed for D1 comes due after the signal
      // moved to D2, inside the frame gap before the cancelling effect runs
      // — the hidden-tab deterministic shape.
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
      // Let the effect arm the debounced save for the first text (due +20ms).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // Replace the signal and let the armed timer come due inside the SAME
      // act — the effect run that would cancel it is deferred to act end.
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
      // The initial load's resolve-time applyGuard in isolation: keystrokes
      // typed during the mount-time get survive its resolution, and no
      // clobbering save of the stale server draft is ever issued.
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
      // The mount-time get hangs; the user types.
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
      // A staging is UNSEEN (it landed server-side; this composer shows only
      // typing). The user clears or sends inside the save debounce, so the
      // STORED draft is still empty: the clear must offer the last displayed
      // content to the composition-aware clearInputDraftIf (no match — the
      // composer never showed the composition) and then clear typing with a
      // BARE empty write, which never consumes the staging. The client itself
      // must never write inputDraftVoicePending.
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
      // Type, then clear INSIDE the debounce window — no timer advance between.
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
      // The client never writes the staging field — consuming it is the
      // daemon's decision on an adopting write or a matching clear only.
      const stagingWrites = mockHub.request.mock.calls.filter(
        ([m, d]) => m === 'session.update' && 'inputDraftVoicePending' in (d?.metadata ?? {})
      );
      expect(stagingWrites).toHaveLength(0);
    });

    it('discards a displayed voice composition atomically and skips the bare typing clear', async () => {
      // The composer LOADED the voice-only composition ('voice' — empty stored
      // typing, pending alone) and the user deliberately cleared it: the clear
      // offers the displayed content to clearInputDraftIf, whose composition
      // match consumes draft + staging together daemon-side. A confirmed
      // clear skips the redundant bare empty write.
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
      // Confirmed clear: no bare empty write follows — the atomic clear
      // already nulled the draft daemon-side.
      expect(mockHub.request).not.toHaveBeenCalledWith('session.update', {
        sessionId: 'session-1',
        metadata: { inputDraft: null },
      });
    });

    it('re-arms the one-shot when the composition exceeds the character limit', async () => {
      // Over-limit: the daemon returns the RAW draft (the composition would
      // not fit whole), so the applied draft does not contain the pending.
      // The refresh would otherwise report success and burn the one-shot
      // re-check while the staging stays invisible; it re-arms instead, so
      // the next empty-composer transition retries the adoption.
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
      // Microtask flush ONLY — no timer advance: the raw draft was applied
      // (the composer shows it) but the IMMEDIATE save was skipped, since it
      // cannot contain the pending and would adopt nothing.
      await act(async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      expect(result.current.content).toBe(rawDraft);
      const rawSaves = mockHub.request.mock.calls.filter(
        ([m, d]) => m === 'session.update' && d?.metadata?.inputDraft === rawDraft
      );
      expect(rawSaves).toHaveLength(0);
      expect(gets()).toBe(getsAfterLoad + 1);
      // The composer empties: the re-armed one-shot retries the refresh —
      // without the re-arm this get never happens and the staging stays
      // invisible until an unrelated trigger.
      act(() => {
        result.current.setContent('');
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(gets()).toBe(getsAfterLoad + 2);
    });

    it('re-arms the one-shot when the immediate adoption save rejects', async () => {
      // The adoption applied and its IMMEDIATE save rejected on a transient
      // socket failure. If the user then clears the composer before the
      // debounced re-save can adopt, the un-adopted staging must not go
      // invisible: the rejection re-arms the one-shot, and the empty
      // transition re-issues the adoption refresh.
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
      // Microtask flush ONLY: the adoption applied and its immediate save
      // rejected (swallowed) — the marker is re-armed.
      await act(async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      expect(result.current.content).toBe('draft voice');
      // Clear before any debounced re-save fires: the empty transition
      // consumes the marker and re-issues the adoption refresh, which
      // re-adopts and this time saves successfully.
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

    it('does not flush a stale pre-adoption draft over the adoption save on session switch', async () => {
      // NOTE: keep this test LAST in the describe. Its rerender-inside-act
      // (required to switch sessions before the deferred save effect runs —
      // the very interleave under test) leaves preact test-utils' act rAF
      // restore wedged, which breaks signal-effect scheduling for any test
      // that follows in the same file.
      // The adoption records the adopted composition as the session's
      // last-seen content BEFORE the immediate save: a session switch in the
      // frame before the deferred save effect runs must flush the ADOPTED
      // value, never the stale pre-adoption draft the switch-flush branch
      // would otherwise read.
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

      const { result, rerender } = renderHook(({ id }) => useInputDraft(id), {
        initialProps: { id: 'session-1' },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.content).toBe('plain draft');
      const listener = captureListener();
      // Adopt, then switch BEFORE the deferred save effect runs — all inside
      // one act so the effect flush happens after the switch.
      await act(async () => {
        listener({ sessionId: 'session-1' }, { channel: 'session:session-1' });
        await vi.advanceTimersByTimeAsync(0);
        rerender({ id: 'session-2' });
        await vi.runAllTimersAsync();
      });
      const s1Updates = mockHub.request.mock.calls
        .filter(([m, d]) => m === 'session.update' && d?.sessionId === 'session-1')
        .map(([, d]) => d?.metadata?.inputDraft);
      const adoptedAt = s1Updates.indexOf('plain draft voice');
      expect(adoptedAt).toBeGreaterThanOrEqual(0);
      expect(s1Updates.slice(adoptedAt + 1)).not.toContain('plain draft');
    });
  });
});

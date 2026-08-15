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
import {
  getDraftBackup,
  markVoiceTranscriptLanded,
  resetVoiceTranscriptOutbox,
  voiceTranscriptLandedSignal,
} from '../../lib/voice/voice-transcript-outbox.ts';

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

    it('refreshes the mounted draft when the outbox lands a transcript for its session', async () => {
      // The initial get sees no draft; the replay's get returns the landed one.
      mockHub.request.mockResolvedValueOnce({ session: { metadata: { inputDraft: '' } } });
      mockHub.request.mockResolvedValue({ session: { metadata: { inputDraft: 'transcript' } } });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      // The composer is mounted with an empty draft when the outbox replays.
      expect(result.current.content).toBe('');

      voiceTranscriptLandedSignal.value = new Map([['session-1', 1]]);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The replay triggered a second session.get, whose merge surfaced the
      // landed transcript into the draft — no navigation required.
      expect(mockHub.request).toHaveBeenCalledWith('session.get', { sessionId: 'session-1' });
      expect(result.current.content).toBe('transcript');
    });

    it('does not clobber in-progress typing when a replay lands for its session', async () => {
      mockHub.request.mockResolvedValue({
        session: { metadata: { inputDraft: 'server text' } },
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      result.current.setContent('user typing');
      voiceTranscriptLandedSignal.value = new Map([['session-1', 1]]);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The get overwrites the local signal — reloading over typing would lose
      // keystrokes, so an idle-only refresh leaves the draft untouched.
      expect(result.current.content).toBe('user typing');
    });

    it('defers the outbox refresh until an active composer is cleared, then applies it', async () => {
      mockHub.request
        .mockResolvedValueOnce({ session: { metadata: { inputDraft: '' } } }) // initial
        .mockResolvedValueOnce({ session: { metadata: { inputDraft: 'transcript' } } }) // deferred get
        .mockResolvedValueOnce({ updated: true, value: 'transcript' }); // strip
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The replay lands while the composer has text — no reload yet.
      result.current.setContent('user typing');
      voiceTranscriptLandedSignal.value = new Map([['session-1', 1]]);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('user typing');
      expect(mockHub.request.mock.calls.filter(([m]) => m === 'session.get')).toHaveLength(1);

      // Once the composer is idle again, the deferred clear-reconcile runs:
      // the get merges, the daemon-side strip keeps only the transcripts.
      result.current.clear();
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(mockHub.request.mock.calls.filter(([m]) => m === 'session.get')).toHaveLength(2);
      expect(result.current.content).toBe('transcript');
    });

    it('keeps the landing pending when the refresh get fails, then applies it on a later trigger', async () => {
      mockHub.request
        .mockResolvedValueOnce({ session: { metadata: { inputDraft: '' } } }) // initial
        .mockRejectedValueOnce(new Error('socket closed')) // replay get fails
        .mockResolvedValue({ session: { metadata: { inputDraft: 'transcript' } } }); // retry
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('');

      // Landing fires; the refresh get fails — the landing must NOT be consumed,
      // or a reconnect could never retry the refresh for the mounted composer.
      voiceTranscriptLandedSignal.value = new Map([['session-1', 1]]);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(true);

      // A later landing event re-triggers the effect; the retry succeeds.
      voiceTranscriptLandedSignal.value = new Map([['session-1', 1]]);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('transcript');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(false);
    });

    it('retries a failed refresh when the connection is restored', async () => {
      mockHub.request
        .mockResolvedValueOnce({ session: { metadata: { inputDraft: '' } } }) // initial
        .mockRejectedValueOnce(new Error('socket closed')) // refresh get fails
        .mockResolvedValue({ session: { metadata: { inputDraft: 'transcript' } } }); // retry
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      connectionState.value = 'disconnected';

      // Landing fires; the refresh get fails on the dropped socket — the
      // landing stays pending for a retry.
      voiceTranscriptLandedSignal.value = new Map([['session-1', 1]]);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(true);

      // The connection restores → the effect re-runs (it reads connectionState)
      // → the pending landing is retried and applied.
      connectionState.value = 'connected';
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('transcript');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(false);
    });

    it('suppresses stale saves while a landing is pending for the session', async () => {
      mockHub.request.mockResolvedValue({ session: { metadata: { inputDraft: '' } } });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      result.current.setContent('draft text');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const savesBefore = mockHub.request.mock.calls.filter(([m]) => m === 'session.update').length;
      expect(savesBefore).toBeGreaterThan(0);

      // A landing is pending (the composer has text, so the refresh defers). A
      // save now would write the STALE local draft over the server draft that
      // may already contain the landed transcript — it must be suppressed.
      voiceTranscriptLandedSignal.value = new Map([['session-1', 1]]);
      result.current.setContent('draft text v2');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const savesAfter = mockHub.request.mock.calls.filter(([m]) => m === 'session.update').length;
      expect(savesAfter).toBe(savesBefore);
    });

    it('keeps the landing when the draft is too full to merge the pending transcript', async () => {
      mockHub.request
        .mockResolvedValueOnce({ session: { metadata: { inputDraft: '' } } }) // initial
        .mockResolvedValueOnce({
          // The daemon RETAINED the pending (draft full) — no merge happened.
          session: { metadata: { inputDraft: 'full', inputDraftVoicePending: 'transcript' } },
        })
        .mockResolvedValue({
          // After the user clears the draft, the retry merges it.
          session: { metadata: { inputDraft: 'transcript' } },
        });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      voiceTranscriptLandedSignal.value = new Map([['session-1', 1]]);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      // The get succeeded but the pending was retained — the landing stays so a
      // later refresh can merge the transcript once the draft has room.
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(true);
      expect(result.current.content).toBe('full');

      result.current.clear();
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('transcript');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(false);
    });

    it('clears through a pending landing by stripping the stale baseline, never the transcript', async () => {
      // Another tab processed the landing first: its get merged the transcript
      // onto the stale baseline this tab's user just sent/cleared.
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return { session: { metadata: { inputDraft: 'text to send transcript' } } };
        }
        if (method === 'session.stripVoiceBaseline') return { updated: true, value: 'transcript' };
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      result.current.setContent('text to send');
      markVoiceTranscriptLanded('session-1', 'transcript');
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The user sends/clears — the reconciliation must end with the draft (and
      // the composer) holding ONLY the transcript. The old unconditional
      // inputDraft:null here would have deleted the other tab's merged
      // transcript entirely.
      result.current.clear();
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const stripCall = mockHub.request.mock.calls.find(
        ([m]) => m === 'session.stripVoiceBaseline'
      );
      expect(stripCall).toBeTruthy();
      expect(stripCall![1]).toEqual({
        sessionId: 'session-1',
        expected: 'text to send transcript',
      });
      expect(result.current.content).toBe('transcript');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(false);
      // No unconditional draft wipe was issued.
      const nullClear = mockHub.request.mock.calls.find(
        ([m, d]) => m === 'session.update' && d?.metadata?.inputDraft === null
      );
      expect(nullClear).toBeFalsy();
    });

    it('clears conditionally then merges when the transcript is still staged (pendingRetained)', async () => {
      const state = { merged: false };
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return state.merged
            ? { session: { metadata: { inputDraft: 'transcript' } } }
            : {
                // Draft too full at merge time — the pending is still staged on
                // top of the stale baseline.
                session: {
                  metadata: { inputDraft: 'stale baseline', inputDraftVoicePending: 'transcript' },
                },
              };
        }
        if (method === 'session.clearInputDraftIf') {
          state.merged = true;
          return { cleared: true };
        }
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      result.current.setContent('text to send');
      markVoiceTranscriptLanded('session-1', 'transcript');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      result.current.clear();
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The stale baseline is cleared CONDITIONALLY (a newer draft saved
      // meanwhile must survive), then the refresh merges the staged pending
      // onto the clean draft.
      const clearCall = mockHub.request.mock.calls.find(([m]) => m === 'session.clearInputDraftIf');
      expect(clearCall).toBeTruthy();
      expect(clearCall![1]).toEqual({ sessionId: 'session-1', expected: 'stale baseline' });
      expect(result.current.content).toBe('transcript');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(false);
    });

    it('does not flush a departed session that has a pending landing', async () => {
      mockHub.request.mockResolvedValue({ session: { metadata: { inputDraft: '' } } });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result, rerender } = renderHook(({ s }) => useInputDraft(s), {
        initialProps: { s: 'session-1' },
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      result.current.setContent('stale text');
      voiceTranscriptLandedSignal.value = new Map([['session-1', 1]]);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Switch away — the flush of session-1's STALE local text must be
      // suppressed, or it would overwrite the transcript another tab merged.
      const before = mockHub.request.mock.calls.filter(([m]) => m === 'session.update').length;
      rerender({ s: 'session-2' });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const after = mockHub.request.mock.calls.filter(([m]) => m === 'session.update').length;
      expect(after).toBe(before);
    });

    it('does not clear a freshly-loaded session because ANOTHER session deferred a landing', async () => {
      mockHub.request.mockResolvedValue({ session: { metadata: { inputDraft: 'B draft' } } });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result, rerender } = renderHook(({ s }) => useInputDraft(s), {
        initialProps: { s: 'session-A' },
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // A has a deferred landing + non-empty text; B also has a landing.
      result.current.setContent('A text');
      voiceTranscriptLandedSignal.value = new Map([
        ['session-A', 1],
        ['session-B', 1],
      ]);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Switching to B must NOT treat B's freshly-loading empty composer as an
      // explicit clear — that would delete B's persisted draft before its
      // pending transcript is merged.
      rerender({ s: 'session-B' });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const clears = mockHub.request.mock.calls.filter(
        ([m, d]) =>
          m === 'session.update' && d?.sessionId === 'session-B' && d?.metadata?.inputDraft === null
      );
      expect(clears).toHaveLength(0);
      expect(result.current.content).toBe('B draft');
    });

    it('advances the session ref past a deferred landing so edits in a new session save', async () => {
      mockHub.request.mockResolvedValue({ session: { metadata: { inputDraft: '' } } });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result, rerender } = renderHook(({ s }) => useInputDraft(s), {
        initialProps: { s: 'session-A' },
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      result.current.setContent('A text');
      voiceTranscriptLandedSignal.value = new Map([['session-A', 1]]);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Switch to B — the suppressed switch flush must still advance the ref.
      rerender({ s: 'session-B' });
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Editing B must save — it must not stay suppressed by A's stale landing.
      const before = mockHub.request.mock.calls.filter(([m]) => m === 'session.update').length;
      result.current.setContent('B draft');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const after = mockHub.request.mock.calls.filter(([m]) => m === 'session.update').length;
      expect(after).toBeGreaterThan(before);
    });

    it('does not merge until the clear commits when a send/clear happened', async () => {
      mockHub.request
        .mockResolvedValueOnce({ session: { metadata: { inputDraft: '' } } }) // initial
        .mockRejectedValueOnce(new Error('socket closed')) // the reconcile get fails
        .mockResolvedValueOnce({
          session: { metadata: { inputDraft: 'text to send transcript' } }, // retry get: merged
        })
        .mockResolvedValue({ updated: true, value: 'transcript' }); // the strip
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      result.current.setContent('text to send');
      markVoiceTranscriptLanded('session-1', 'transcript');
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The user clears; the reconcile get FAILS on the dropped socket — the
      // landing must stay pending (nothing was reconciled) and no conditional
      // RPC ran.
      result.current.clear();
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(true);
      expect(
        mockHub.request.mock.calls.filter(([m]) => m === 'session.stripVoiceBaseline')
      ).toHaveLength(0);
      expect(
        mockHub.request.mock.calls.filter(([m]) => m === 'session.clearInputDraftIf')
      ).toHaveLength(0);

      // A reconnect retries the reconcile: the get sees the merged draft and
      // strips the stale baseline to the transcript.
      connectionState.value = 'connected';
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(false);
      expect(result.current.content).toBe('transcript');
    });

    it('preserves edits to the draft backup while a landing is pending', async () => {
      mockHub.request.mockResolvedValue({ session: { metadata: { inputDraft: '' } } });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      result.current.setContent('editing');
      voiceTranscriptLandedSignal.value = new Map([['session-1', 1]]);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      // The stale server save is suppressed (landing pending), but the evolving
      // local draft is backed up so a reload/switch does not lose it.
      expect(getDraftBackup('session-1')).toBe('editing');
      expect(mockHub.request.mock.calls.filter(([m]) => m === 'session.update')).toHaveLength(0);
    });

    it('folds the merged transcript into a restored draft backup on reload', async () => {
      // A previous page life deferred a landing while the user typed: the
      // backup holds their edits, the landing marker holds the transcript, and
      // this reload's initial get merges the pending server-side.
      markVoiceTranscriptLanded('session-1', 'voice');
      localStorage.setItem(
        'hyperneo_voice_transcript_outbox_v1.draft.session-1',
        JSON.stringify({ content: 'hello world', ts: Date.now(), generation: 1 })
      );
      mockHub.request.mockResolvedValue({
        // Merged already: draft = baseline + transcript, with the daemon's
        // baseline snapshot carried in the response.
        session: {
          metadata: { inputDraft: 'hello voice', inputDraftVoiceBaseline: 'hello' },
        },
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The backup is restored AND the transcript folded in, so the re-enabled
      // saves persist the combined draft instead of clobbering the merged
      // transcript with the transcript-free backup — and without duplicating
      // the stale baseline ("hello world hello voice").
      expect(result.current.content).toBe('hello world voice');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(false);
      expect(
        localStorage.getItem('hyperneo_voice_transcript_outbox_v1.draft.session-1')
      ).toBeNull();
      // The landing was settled by the INITIAL load — no second refresh get
      // raced the restore.
      expect(mockHub.request.mock.calls.filter(([m]) => m === 'session.get')).toHaveLength(1);
    });

    it('does not fold or consume when the reload could not merge (pendingRetained)', async () => {
      markVoiceTranscriptLanded('session-1', 'voice');
      localStorage.setItem(
        'hyperneo_voice_transcript_outbox_v1.draft.session-1',
        JSON.stringify({ content: 'hello world', ts: Date.now(), generation: 1 })
      );
      mockHub.request.mockResolvedValue({
        // Draft too full — the pending is still staged server-side.
        session: { metadata: { inputDraft: 'hello world', inputDraftVoicePending: 'voice' } },
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The backup restores as-is (the transcript is not in the server draft),
      // and the landing stays pending for the deferred refresh path.
      expect(result.current.content).toBe('hello world');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(true);
    });

    it('preserves every queued transcript when stripping a cleared baseline', async () => {
      // Two outbox entries replayed while the composer had text — both
      // accumulated into the pending and merged onto the stale baseline.
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return { session: { metadata: { inputDraft: 'baseline first second' } } };
        }
        // The daemon's baseline snapshot is exact across every entry of the
        // sequence, regardless of which tabs appended or which marker knows
        // what — the strip keeps BOTH transcripts.
        if (method === 'session.stripVoiceBaseline') {
          return { updated: true, value: 'first second' };
        }
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      result.current.setContent('typed');
      markVoiceTranscriptLanded('session-1', 'first');
      markVoiceTranscriptLanded('session-1', 'second');
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      result.current.clear();
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The strip keeps the WHOLE sequence (both transcripts), not just the
      // latest landing's text.
      const stripCall = mockHub.request.mock.calls.find(
        ([m]) => m === 'session.stripVoiceBaseline'
      );
      expect(stripCall).toBeTruthy();
      expect(stripCall![1]).toEqual({
        sessionId: 'session-1',
        expected: 'baseline first second',
      });
      expect(result.current.content).toBe('first second');
    });

    it('appends a duplicate-phrase transcript on restore instead of substring-skipping it', async () => {
      // The user's backed-up draft and the voice transcript are the SAME
      // phrase — a presence check would treat the transcript as already
      // folded and let the re-enabled save overwrite the merged two-occurrence
      // draft, dropping the voice occurrence.
      markVoiceTranscriptLanded('session-1', 'hello');
      localStorage.setItem(
        'hyperneo_voice_transcript_outbox_v1.draft.session-1',
        JSON.stringify({ content: 'hello', ts: Date.now(), generation: 1 })
      );
      mockHub.request.mockResolvedValue({
        // merged: both occurrences, baseline snapshot tells them apart
        session: {
          metadata: { inputDraft: 'hello hello', inputDraftVoiceBaseline: 'hello' },
        },
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.content).toBe('hello hello');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(false);
    });

    it('guards the strip with the sequence id observed in the get response', async () => {
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return {
            session: {
              metadata: {
                inputDraft: 'stale baseline transcript',
                inputDraftVoiceBaseline: 'stale baseline',
                inputDraftVoiceBaselineSeq: 4,
              },
            },
          };
        }
        if (method === 'session.stripVoiceBaseline') {
          return { updated: true, value: 'transcript' };
        }
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      result.current.setContent('typed');
      markVoiceTranscriptLanded('session-1', 'transcript');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      result.current.clear();
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The strip validates the SEQUENCE the client observed, not just the
      // draft text — a newer sequence can replace the baseline while leaving
      // the draft unchanged, and stripping on text alone would clear the
      // merged transcript.
      const stripCall = mockHub.request.mock.calls.find(
        ([m]) => m === 'session.stripVoiceBaseline'
      );
      expect(stripCall).toBeTruthy();
      expect(stripCall![1]).toEqual({
        sessionId: 'session-1',
        expected: 'stale baseline transcript',
        expectedSeq: 4,
      });
    });

    it('folds a landing generation at most once across overlapping refreshes', async () => {
      const gets: Array<{ resolve: (value: unknown) => void }> = [];
      mockHub.request.mockImplementation((method: string) => {
        if (method !== 'session.get')
          return Promise.resolve({ updated: true, value: 'transcript' });
        let resolve!: (value: unknown) => void;
        const promise = new Promise((r) => {
          resolve = r;
        });
        gets.push({ resolve });
        return promise;
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      // Initial load resolves; the replay refresh (get #2) stays pending.
      await act(async () => {
        gets[0]?.resolve({ session: { metadata: { inputDraft: '' } } });
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        markVoiceTranscriptLanded('session-1', 'transcript');
      });
      expect(gets.length).toBe(2); // the refresh get is in flight

      // The user types then clears again — cancelling get #2's effect run and
      // starting the clear-path get #3, which strips to the transcripts.
      await act(async () => {
        result.current.setContent('typing');
      });
      await act(async () => {
        result.current.clear();
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        gets[2]?.resolve({
          session: {
            metadata: {
              inputDraft: 'baseline transcript',
              inputDraftVoiceBaseline: 'baseline',
              inputDraftVoiceBaselineSeq: 1,
            },
          },
        });
        await vi.runAllTimersAsync();
      });
      // Strip already settled the landing (content = transcripts).
      expect(result.current.content).toBe('transcript');

      // The CANCELLED get #2 resolves last with the same merged draft — its
      // reconcile fold must NOT append the transcript a second time.
      await act(async () => {
        gets[1]?.resolve({
          session: {
            metadata: {
              inputDraft: 'baseline transcript',
              inputDraftVoiceBaseline: 'baseline',
              inputDraftVoiceBaselineSeq: 1,
            },
          },
        });
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('transcript');
    });

    it('retries a departed session backup flush after reconnecting', async () => {
      // Session A: landing expires while its recently-edited backup survives.
      mockHub.request.mockResolvedValue({ session: { metadata: { inputDraft: '' } } });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
      const { result, rerender } = renderHook(({ s }) => useInputDraft(s), {
        initialProps: { s: 'session-A' },
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      result.current.setContent('A edits');
      markVoiceTranscriptLanded('session-A', 'voice');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
      });
      result.current.setContent('A edits v2');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      });

      // Switch away while DISCONNECTED — the flush can't run, but must be
      // retained for the reconnect instead of dying with the switch.
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
      rerender({ s: 'session-B' });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const before = mockHub.request.mock.calls.filter(
        ([m, d]) => m === 'session.update' && d?.sessionId === 'session-A'
      ).length;
      expect(before).toBe(0);

      // Reconnect (still viewing B): the retained flush pushes A's backup.
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
      connectionState.value = 'connected';
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const flush = mockHub.request.mock.calls.find(
        ([m, d]) =>
          m === 'session.update' &&
          d?.sessionId === 'session-A' &&
          d?.metadata?.inputDraft === 'A edits v2'
      );
      expect(flush).toBeTruthy();
    });

    it('persists an owed clear across a reload via the tombstone (no backup resurrection)', async () => {
      // First page life: deferred landing with a backup, then the user clears
      // while DISCONNECTED — the owed clear must survive the reload.
      mockHub.request.mockResolvedValue({ session: { metadata: { inputDraft: '' } } });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
      const first = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        first.result.current.setContent('sent text');
        markVoiceTranscriptLanded('session-1', 'voice');
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
      await act(async () => {
        first.result.current.clear();
        await vi.runAllTimersAsync();
      });
      // The backup holds the pre-clear text; the tombstone records the clear.
      expect(
        localStorage.getItem('hyperneo_voice_transcript_outbox_v1.draft.session-1')
      ).not.toBeNull();
      expect(
        localStorage.getItem('hyperneo_voice_transcript_outbox_v1.clear.session-1')
      ).not.toBeNull();
      first.unmount();

      // Reload (new hook, same storage): the pre-clear backup must NOT be
      // restored — the owed clear reconciles instead.
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return {
            session: {
              metadata: {
                inputDraft: 'sent text voice',
                inputDraftVoiceBaseline: 'sent text',
                inputDraftVoiceBaselineSeq: 1,
              },
            },
          };
        }
        if (method === 'session.stripVoiceBaseline') {
          return { updated: true, value: 'voice' };
        }
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
      const second = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });
      // The clear is owed: the strip runs and the composer holds only the
      // transcript — the sent text is not resurrected from the backup.
      expect(second.result.current.content).toBe('voice');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(false);
      // The tombstone is retired once the reconcile committed.
      expect(
        localStorage.getItem('hyperneo_voice_transcript_outbox_v1.clear.session-1')
      ).toBeNull();
    });

    it('reconciles an owed clear directly when its landing expired (tombstone only)', async () => {
      // The landing marker aged past its TTL and was pruned, but the owed
      // clear tombstone is fresh: no replay effect will fire, so the settle
      // handler must reconcile against the daemon directly.
      localStorage.setItem(
        'hyperneo_voice_transcript_outbox_v1.clear.session-1',
        JSON.stringify({ ts: Date.now() })
      );
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return {
            session: {
              metadata: {
                inputDraft: 'sent text voice',
                inputDraftVoiceBaseline: 'sent text',
                inputDraftVoiceBaselineSeq: 1,
              },
            },
          };
        }
        if (method === 'session.stripVoiceBaseline') {
          return { updated: true, value: 'voice' };
        }
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The strip runs without any live landing; the sent text does not
      // resurrect and the tombstone retires.
      const stripCall = mockHub.request.mock.calls.find(
        ([m]) => m === 'session.stripVoiceBaseline'
      );
      expect(stripCall).toBeTruthy();
      expect(result.current.content).toBe('voice');
      expect(
        localStorage.getItem('hyperneo_voice_transcript_outbox_v1.clear.session-1')
      ).toBeNull();
    });

    it('adopts a retained backup flush when the user returns to its session', async () => {
      mockHub.request.mockResolvedValue({ session: { metadata: { inputDraft: '' } } });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
      const { result, rerender } = renderHook(({ s }) => useInputDraft(s), {
        initialProps: { s: 'session-A' },
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      result.current.setContent('A edits');
      markVoiceTranscriptLanded('session-A', 'voice');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
      });
      result.current.setContent('A edits v2');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      });

      // Switch away offline (flush retained), come back to A, then reconnect
      // with an idle composer: the backup's edits are adopted into the
      // composer rather than dropped.
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
      rerender({ s: 'session-B' });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      rerender({ s: 'session-A' });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('');

      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
      connectionState.value = 'connected';
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('A edits v2');
      expect(getDraftBackup('session-A')).toBeNull();
    });

    it('does not fold a cancelled replay whose pending was RETAINED (not merged)', async () => {
      let resolveGet!: (value: unknown) => void;
      mockHub.request
        .mockResolvedValueOnce({ session: { metadata: { inputDraft: '' } } }) // initial
        .mockImplementationOnce(
          () =>
            new Promise((r) => {
              resolveGet = r;
            })
        ); // refresh get
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      markVoiceTranscriptLanded('session-1', 'transcript');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      // The user types, cancelling the in-flight refresh get...
      await act(async () => {
        result.current.setContent('typing');
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      // ...which resolves with the pending RETAINED (draft too full — no merge
      // happened; the transcript is still staged server-side).
      await act(async () => {
        resolveGet({
          session: { metadata: { inputDraft: 'full', inputDraftVoicePending: 'transcript' } },
        });
        await vi.runAllTimersAsync();
      });
      // The transcript must NOT be folded into local text (it is not on the
      // server draft yet — folding now would duplicate it after the later
      // real merge) and the landing stays pending.
      expect(result.current.content).toBe('typing');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(true);
    });

    it('flushes a departed session whose landing has expired (>24h)', async () => {
      mockHub.request.mockResolvedValue({ session: { metadata: { inputDraft: '' } } });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result, rerender } = renderHook(({ s }) => useInputDraft(s), {
        initialProps: { s: 'session-A' },
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      result.current.setContent('A text');
      markVoiceTranscriptLanded('session-A', 'voice');
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The landing ages past 24h, but the user kept editing recently — the
      // draft backup (the only record, saves being suppressed) stays fresh.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
      });
      result.current.setContent('A text v2');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      });

      // The landing is now expired (25h) while the backup is 2h old — the
      // switch flush must NOT be skipped, and must CLAIM the backup's edits:
      // a reopen would reject the backup (landing dead), so this flush is
      // their only path to the server.
      rerender({ s: 'session-B' });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const flush = mockHub.request.mock.calls.find(
        ([m, d]) =>
          m === 'session.update' &&
          d?.sessionId === 'session-A' &&
          d?.metadata?.inputDraft === 'A text v2'
      );
      expect(flush).toBeTruthy();
      expect(getDraftBackup('session-A')).toBeNull();
    });

    it('consumes the landing when a cancelled refresh still resolved (server merged it)', async () => {
      let resolveGet!: (value: { session: { metadata: { inputDraft?: string } } }) => void;
      mockHub.request
        .mockResolvedValueOnce({ session: { metadata: { inputDraft: '' } } }) // initial
        .mockImplementationOnce(
          () =>
            new Promise((r) => {
              resolveGet = r;
            })
        ); // refresh get
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      await act(async () => {
        markVoiceTranscriptLanded('session-1', 'transcript');
      });
      // The refresh get is now in-flight.
      expect(resolveGet).toBeTypeOf('function');
      // The user types — cancelling that effect run, but the server-side merge
      // of the in-flight get still happens.
      await act(async () => {
        result.current.setContent('typing');
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        resolveGet({ session: { metadata: { inputDraft: 'baseline transcript' } } });
        await vi.runAllTimersAsync();
      });
      // The landing is consumed — a later clear must not delete the merged
      // transcript — and ONLY the transcript (not the whole merged draft with
      // its stale baseline) was folded into the local typed text so a
      // subsequent save does not overwrite it.
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(false);
      expect(result.current.content).toBe('typing transcript');
    });

    it('cancels a scheduled save when a landing arrives before it fires', async () => {
      mockHub.request.mockResolvedValue({ session: { metadata: { inputDraft: '' } } });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      result.current.setContent('pending save');
      // The debounce is scheduled but NOT yet fired when the landing arrives —
      // the effect must cancel that timer before suppressing, or it would issue
      // a stale session.update over the merged server draft.
      voiceTranscriptLandedSignal.value = new Map([['session-1', 1]]);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const saves = mockHub.request.mock.calls.filter(([m]) => m === 'session.update');
      expect(saves).toHaveLength(0);
    });

    it('does not apply a draft whose session.get resolved after the session changed', async () => {
      // Each session.get gets its own deferred promise so we can resolve
      // session-1's slow get only after the hook has moved on to session-2.
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

      const { result, rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId), {
        initialProps: { sessionId: 'session-1' },
      });

      // Switch to session-2 BEFORE session-1's get resolves.
      rerender({ sessionId: 'session-2' });

      await act(async () => {
        // session-1's get finally resolves with its (now stale) draft.
        gets[0]?.resolve({ session: { metadata: { inputDraft: 'session-1 draft' } } });
        await vi.runAllTimersAsync();
      });

      // The stale session-1 draft must not bleed into the session-2 composer.
      expect(result.current.content).not.toBe('session-1 draft');
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
});

// @ts-nocheck
/**
 * Tests for useInputDraft Hook
 *
 * Tests draft persistence, debounced saving, and content management.
 * Uses Preact Signals internally to prevent lost keystrokes.
 * Note: Tests that require connection mocking are limited due to module initialization order.
 */

import { act, renderHook } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionManager } from '../../lib/connection-manager.ts';
import { connectionState } from '../../lib/state.ts';
import {
  getClearTombstone,
  getDraftBackup,
  hasClearTombstone,
  markVoiceTranscriptLanded,
  peekExpiredDraftBackup,
  resetVoiceTranscriptOutbox,
  saveClearTombstone,
  saveDraftBackup,
  voiceTranscriptLandedSignal,
} from '../../lib/voice/voice-transcript-outbox.ts';
import { useInputDraft } from '../useInputDraft.ts';

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
      saveDraftBackup(
        'session-1',
        'hello world',
        voiceTranscriptLandedSignal.value.get('session-1') ?? 1
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
      // The combined text is durable only in the composer signal until the
      // debounced save commits — the backup SURVIVES the fold and is retired
      // only once that save is acknowledged (a reload inside the debounce
      // window must not lose the user's edits).
      expect(peekExpiredDraftBackup('session-1')).not.toBeNull();
      // The landing was settled by the INITIAL load — no second refresh get
      // raced the restore.
      expect(mockHub.request.mock.calls.filter(([m]) => m === 'session.get')).toHaveLength(1);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const saveCalls = mockHub.request.mock.calls.filter(([m]) => m === 'session.update');
      expect(saveCalls.length).toBeGreaterThan(0);
      // Acknowledged save — the deferred retirement fires now.
      expect(peekExpiredDraftBackup('session-1')).toBeNull();
    });

    it('does not fold or consume when the reload could not merge (pendingRetained)', async () => {
      markVoiceTranscriptLanded('session-1', 'voice');
      saveDraftBackup('session-1', 'hello world', 1);
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
      saveDraftBackup('session-1', 'hello', 1);
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
      mockHub.request.mockImplementation(async (method: string, payload?: { content?: string }) =>
        method === 'session.mergeVoiceDraftBackup'
          ? { merged: true, value: payload?.content ?? '' }
          : { session: { metadata: { inputDraft: '' } } }
      );
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
        ([m, d]) =>
          (m === 'session.update' || m === 'session.mergeVoiceDraftBackup') &&
          d?.sessionId === 'session-A'
      ).length;
      expect(before).toBe(0);

      // Reconnect (still viewing B): the retained flush pushes A's backup
      // through the daemon-side merge (it folds any merged transcripts in
      // instead of clobbering them with the transcript-free backup).
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
      connectionState.value = 'connected';
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const flush = mockHub.request.mock.calls.find(
        ([m, d]) =>
          m === 'session.mergeVoiceDraftBackup' &&
          d?.sessionId === 'session-A' &&
          d?.content === 'A edits v2'
      );
      expect(flush).toBeTruthy();
    });

    it('requeues a DECLINED backup merge for a departed session and retries it', async () => {
      // The daemon declines the merge while a newer voice sequence is
      // unresolved (the draft diverged from its baseline). Dropping the
      // claim there would strand the backup — the switch was its only other
      // trigger — so it must requeue with backoff and merge once the
      // sequence settles.
      let mergeCalls = 0;
      mockHub.request.mockImplementation(async (method: string, payload?: { content?: string }) => {
        if (method === 'session.mergeVoiceDraftBackup') {
          mergeCalls += 1;
          return mergeCalls === 1
            ? { merged: false }
            : { merged: true, value: payload?.content ?? '' };
        }
        return { session: { metadata: { inputDraft: '' } } };
      });
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

      // Switch away offline, then reconnect: the first merge is DECLINED...
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
      rerender({ s: 'session-B' });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
      connectionState.value = 'connected';
      await act(async () => {
        // Enough for the immediate merge attempt, not the 5s backoff retry.
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(mergeCalls).toBe(1);

      // ...the backoff retry merges, and only then retires the backup.
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(mergeCalls).toBeGreaterThanOrEqual(2);
      expect(peekExpiredDraftBackup('session-A')).toBeNull();
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
      // The raw backup key still holds the pre-clear text, but the tombstone
      // marks its OWNER as cleared — the backup is unclaimable from now on,
      // so a restore can never resurrect the sent text.
      expect(peekExpiredDraftBackup('session-1')).toBeNull();
      expect(hasClearTombstone('session-1')).toBe(true);
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
      expect(hasClearTombstone('session-1')).toBe(false);
    });

    it('keeps the owed-clear tombstone when the conditional reconcile is declined', async () => {
      saveClearTombstone('session-1');
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
        // A newer sequence/draft raced the reconcile — both conditional RPCs
        // decline rather than stomp it.
        if (method === 'session.stripVoiceBaseline') return { updated: false };
        if (method === 'session.clearInputDraftIf') return { cleared: false };
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

      // Nothing was applied and the tombstone stays — the reconnect
      // subscription retries with a fresh read of the raced state.
      expect(result.current.content).toBe('sent text voice');
      expect(hasClearTombstone('session-1')).toBe(true);
    });

    it('reconciles an owed clear directly when its landing expired (tombstone only)', async () => {
      // The landing marker aged past its TTL and was pruned, but the owed
      // clear tombstone is fresh: no replay effect will fire, so the settle
      // handler must reconcile against the daemon directly.
      saveClearTombstone('session-1');
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
      expect(hasClearTombstone('session-1')).toBe(false);
    });

    it('adopts a retained backup flush when the user returns to its session', async () => {
      mockHub.request.mockImplementation(async (method: string, payload?: { content?: string }) =>
        method === 'session.mergeVoiceDraftBackup'
          ? { merged: true, value: payload?.content ?? '' }
          : { session: { metadata: { inputDraft: '' } } }
      );
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
      mockHub.request.mockImplementation(async (method: string, payload?: { content?: string }) =>
        method === 'session.mergeVoiceDraftBackup'
          ? { merged: true, value: payload?.content ?? '' }
          : { session: { metadata: { inputDraft: '' } } }
      );
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
          m === 'session.mergeVoiceDraftBackup' &&
          d?.sessionId === 'session-A' &&
          d?.content === 'A text v2'
      );
      expect(flush).toBeTruthy();
      expect(getDraftBackup('session-A')).toBeNull();
    });

    it('clears the in-memory owed-clear marker once the reconcile commits', async () => {
      // An owed clear whose landing EXPIRED: the durable tombstone survives,
      // the marker is gone. The initial settle reconciles it directly against
      // the daemon's baseline snapshot.
      saveClearTombstone('session-1');
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
        if (method === 'session.stripVoiceBaseline') return { updated: true, value: 'voice' };
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const strips = () =>
        mockHub.request.mock.calls.filter(([m]) => m === 'session.stripVoiceBaseline').length;
      expect(strips()).toBe(1);
      expect(hasClearTombstone('session-1')).toBe(false);

      // A NEW transcript lands for this session while the composer is idle: a
      // stale in-memory owed-clear ref would treat the landing as another owed
      // clear and strip the NEW sequence's baseline, deleting draft content
      // the user never cleared.
      markVoiceTranscriptLanded('session-1', 'new voice');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(strips()).toBe(1);
      // No clear is owed — the landing defers behind the non-empty composer.
      expect(result.current.content).toBe('voice');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(true);
    });

    it('retries an owed clear even while the composer holds the merged draft', async () => {
      // The owed-clear chain's get fills the composer with the merged
      // baseline+transcript, then the strip REJECTS (socket dropped). The
      // non-empty deferral must not swallow the retry: the content is the
      // SERVER's draft, not user typing, and deferring it would leave the
      // already-sent text resurrected for the rest of the page life.
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
        if (method === 'session.stripVoiceBaseline') throw new Error('socket dropped');
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      // A live landing defers behind the user's text; the user then sends.
      result.current.setContent('sent text');
      markVoiceTranscriptLanded('session-1', 'voice');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      result.current.clear();
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      // First pass: the chain's get applied the merged draft, the strip
      // failed, the clear stays owed with the composer holding the merged text.
      expect(result.current.content).toBe('sent text voice');
      expect(hasClearTombstone('session-1')).toBe(true);
      expect(
        mockHub.request.mock.calls.filter(([m]) => m === 'session.stripVoiceBaseline').length
      ).toBeGreaterThan(0);

      // A reconnect (or any re-run) must RETRY the owed clear despite the
      // non-empty composer — the transcript-only result replaces the
      // resurrected baseline once the strip succeeds.
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
        if (method === 'session.stripVoiceBaseline') return { updated: true, value: 'voice' };
        return {};
      });
      connectionState.value = 'connected';
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('voice');
      expect(hasClearTombstone('session-1')).toBe(false);
    });

    it('folds the stripped transcripts into typing that began mid-strip', async () => {
      // The clear chain's get applied the merged draft; the user typed
      // BEFORE the strip acknowledged. The transcript-only strip result must
      // not overwrite the newer typing — but consuming the landing without
      // folding would lift the save suppression while the strip already
      // cleared the daemon baseline, so the next plain save would replace
      // the transcript-only server draft with transcript-free typing and
      // lose the voice text permanently.
      let resolveStrip: ((v: { updated: boolean; value?: string }) => void) | null = null;
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
          return new Promise((resolve) => {
            resolveStrip = resolve;
          });
        }
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      // A live landing defers behind the user's text; the user then sends.
      result.current.setContent('sent text');
      markVoiceTranscriptLanded('session-1', 'voice');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      result.current.clear();
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      // The chain's get applied the merged draft; the strip is in flight.
      expect(result.current.content).toBe('sent text voice');
      // Typing began after the get resolved, before the strip acknowledged.
      result.current.setContent('sent text and more typing');
      await act(async () => {
        resolveStrip?.({ updated: true, value: 'voice' });
        await vi.runAllTimersAsync();
      });
      // The transcripts are FOLDED into the newer typing (the strip was
      // never cancelled, so no reconcile-on-cancel fold ran for them), so
      // the re-enabled saves carry BOTH instead of clobbering the
      // transcript-only server draft.
      expect(result.current.content).toBe('sent text and more typing voice');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(false);
    });

    it('keeps the clear owed when the live strip fold cannot fit whole', async () => {
      // Same chain as the fold test above, but the mid-strip typing plus the
      // stripped transcripts exceeds the draft limit: appendDraftText would
      // silently truncate the transcript's tail, and consuming the landing
      // anyway would lift the save suppression so the next plain save
      // overwrites the daemon's complete transcript-only draft with the
      // truncated combination. The clear stays owed instead — the versioned
      // tombstone records the strip that already committed — and retries
      // when room appears.
      let resolveStrip: ((v: { updated: boolean; value?: string }) => void) | null = null;
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
          return new Promise((resolve) => {
            resolveStrip = resolve;
          });
        }
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      result.current.setContent('sent text');
      markVoiceTranscriptLanded('session-1', 'voice');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      result.current.clear();
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('sent text voice');
      // Typing grew past the point where the stripped transcripts can fold
      // in whole (the draft limit is 100_000 characters).
      result.current.setContent(`${'x'.repeat(100_000)} tail`);
      const before = result.current.content;
      await act(async () => {
        resolveStrip?.({ updated: true, value: 'voice' });
        await vi.runAllTimersAsync();
      });
      // No truncating fold: the typing stays untouched, the landing stays
      // UNCONSUMED (the save suppression holds), and the owed clear's
      // tombstone is VERSIONED with the committed strip's sequence.
      expect(result.current.content).toBe(before);
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(true);
      expect(hasClearTombstone('session-1')).toBe(true);
      expect(getClearTombstone('session-1')?.baselineSeq).toBe(1);
    });

    it('versions an unversioned owed tombstone with the sequence before stripping', async () => {
      // The original owe ran offline (no get had happened), so the tombstone
      // carries no baselineSeq. The reconcile learns the sequence from its
      // get — and must write it back BEFORE the strip is in flight, or a
      // strip that commits with a lost ack can never be recognized (the
      // unversioned retry falls into the no-baseline conditional clear and
      // deletes the transcript-only draft).
      saveClearTombstone('session-1');
      expect(getClearTombstone('session-1')?.baselineSeq).toBeUndefined();
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return {
            session: {
              metadata: {
                inputDraft: 'sent text voice',
                inputDraftVoiceBaseline: 'sent text',
                inputDraftVoiceBaselineSeq: 2,
              },
            },
          };
        }
        if (method === 'session.stripVoiceBaseline') throw new Error('socket dropped');
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The strip failed — the tombstone stays owed, now VERSIONED so the
      // retry recognizes a committed-but-unacked strip.
      expect(hasClearTombstone('session-1')).toBe(true);
      expect(getClearTombstone('session-1')?.baselineSeq).toBe(2);
    });

    it('persists a pendingRetained expired-landing restore through an acknowledged merge', async () => {
      // The landing marker is long pruned but the backup is fresh, and the
      // daemon RETAINED the pending (draft too full to merge). The restore
      // must not delete the durable copy on the spot — the debounced save
      // alone could be lost to a reload or dropped socket — but persist it
      // through the daemon-side merge and retire only on the acknowledgement.
      saveDraftBackup('session-1', 'user edits', 1);
      let mergeCommitted = false;
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return {
            session: {
              metadata: { inputDraft: 'full draft', inputDraftVoicePending: 'voice' },
            },
          };
        }
        if (method === 'session.mergeVoiceDraftBackup') {
          mergeCommitted = true;
          return { merged: true, value: 'user edits' };
        }
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      // The queued merge runs through the retry backoff — arm it.
      connectionState.value = 'connected';
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.content).toBe('user edits');
      expect(mergeCommitted).toBe(true);
      expect(peekExpiredDraftBackup('session-1')).toBeNull();
    });

    it('keeps the durable backup when the pendingRetained merge cannot commit', async () => {
      // Same restore, but the merge is DECLINED (a newer sequence is
      // unresolved): the backup stays — a later departed-session flush
      // retries it, and deleting it here would leave only the un-committed
      // debounced save.
      saveDraftBackup('session-1', 'user edits', 1);
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return {
            session: {
              metadata: { inputDraft: 'full draft', inputDraftVoicePending: 'voice' },
            },
          };
        }
        if (method === 'session.mergeVoiceDraftBackup') return { merged: false };
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.content).toBe('user edits');
      expect(peekExpiredDraftBackup('session-1')?.content).toBe('user edits');
    });

    it('reschedules a departed-session backup merge declined on its first attempt', async () => {
      // The first merge attempt runs while CONNECTED and is DECLINED (a
      // newer sequence is unresolved): queueRetry must arm the backoff pass,
      // or the claim idles in localStorage until the TTL prunes it — no
      // connection transition or later switch ever revisits it.
      let attempts = 0;
      mockHub.request.mockImplementation(async (method: string, payload?: { content?: string }) => {
        if (method === 'session.mergeVoiceDraftBackup') {
          attempts += 1;
          return attempts === 1
            ? { merged: false }
            : { merged: true, value: payload?.content ?? '' };
        }
        return { session: { metadata: { inputDraft: '' } } };
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
      connectionState.value = 'connected'; // the armed kick only fires while connected
      const { result, rerender } = renderHook(({ s }) => useInputDraft(s), {
        initialProps: { s: 'session-A' },
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      // The switch-flush effect re-runs on the content CHANGE the session
      // switch applies, so session-A must hold text before departing.
      result.current.setContent('edits');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      saveDraftBackup('session-A', 'edits', 1);

      rerender({ s: 'session-B' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(attempts).toBe(1); // the first, declined attempt — nothing else fires yet

      // No connection change occurs: only the armed backoff pass can retry.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(peekExpiredDraftBackup('session-A')).toBeNull(); // retired on the ack'd merge
    });

    it('queues a live-landing backup for merge when the user switches away', async () => {
      // Typing while a landing is deferred suppresses server saves into the
      // backup; switching away must SCHEDULE that backup through the merge
      // queue — nothing else rechecks the inactive session when the marker
      // later expires, so an abandoned claim would be TTL-pruned and the
      // suppressed edits lost.
      mockHub.request.mockImplementation(async (method: string, payload?: { content?: string }) =>
        method === 'session.mergeVoiceDraftBackup'
          ? { merged: true, value: payload?.content ?? '' }
          : { session: { metadata: { inputDraft: '' } } }
      );
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
      const { result, rerender } = renderHook(({ s }) => useInputDraft(s), {
        initialProps: { s: 'session-A' },
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      result.current.setContent('suppressed edits');
      markVoiceTranscriptLanded('session-A', 'voice');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(peekExpiredDraftBackup('session-A')?.content).toBe('suppressed edits');

      // Switch away while the landing is still LIVE — the queued claim reaches
      // the daemon through the merge (transcripts folded or re-anchored), and
      // the durable copy retires only on the acknowledged merge.
      rerender({ s: 'session-B' });
      // Kick the merge retry directly (the connection subscription only
      // fires on connection CHANGES, and this test stays connected).
      connectionState.value = 'disconnected';
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      connectionState.value = 'connected';
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const merge = mockHub.request.mock.calls.find(
        ([m, d]) => m === 'session.mergeVoiceDraftBackup' && d?.sessionId === 'session-A'
      );
      expect(merge?.[1]?.content).toBe('suppressed edits');
      expect(peekExpiredDraftBackup('session-A')).toBeNull();
    });

    it('retires an active-superseded backup only after the active content commits', async () => {
      // The user returned to a queued-claim session and TYPED before the
      // reconnect: the active content supersedes the backup, but the durable
      // copy must survive until that content is acknowledged server-side —
      // the debounced save alone can be lost to a reload or disconnect.
      mockHub.request.mockImplementation(async (method: string, payload?: { content?: string }) =>
        method === 'session.mergeVoiceDraftBackup'
          ? { merged: true, value: payload?.content ?? '' }
          : { session: { metadata: { inputDraft: '' } } }
      );
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
      const { result, rerender } = renderHook(({ s }) => useInputDraft(s), {
        initialProps: { s: 'session-A' },
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      result.current.setContent('stale edits');
      markVoiceTranscriptLanded('session-A', 'voice');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
      });
      // Refresh the backup just before the landing expires, so the durable
      // copy outlives the marker.
      result.current.setContent('stale edits v2');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000); // landing expires
      });

      // Switch away offline (claim queued), return, type, then reconnect.
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
      rerender({ s: 'session-B' });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      rerender({ s: 'session-A' });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      result.current.setContent('newer typing');
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
      connectionState.value = 'connected';
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const merge = mockHub.request.mock.calls.find(
        ([m, d]) => m === 'session.mergeVoiceDraftBackup' && d?.sessionId === 'session-A'
      );
      // The ACTIVE content was persisted through the merge (not the stale
      // backup), and only then did the durable copy retire.
      expect(merge?.[1]?.content).toBe('newer typing');
      expect(peekExpiredDraftBackup('session-A')).toBeNull();
    });

    it('merges a RETAINED pending after the expired-landing clear (reconcileOwedClear)', async () => {
      // The landing marker expired but the owed clear's tombstone is fresh,
      // and the get RETAINED the pending (draft too full). Reconciling must
      // clear conditionally and then GET again so the staged transcript
      // merges onto the clean draft — otherwise it stays invisible in the
      // composer (no live landing means no replay effect to refresh).
      saveClearTombstone('session-1');
      let getCalls = 0;
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          getCalls += 1;
          // The initial load AND the reconcile's read both retain the pending
          // (draft full); the post-clear get merges it.
          const retained = getCalls <= 2;
          return {
            session: {
              metadata: {
                inputDraft: retained ? 'full draft' : 'voice',
                inputDraftVoicePending: retained ? 'voice' : null,
              },
            },
          };
        }
        if (method === 'session.clearInputDraftIf') return { cleared: true };
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.content).toBe('voice');
      expect(hasClearTombstone('session-1')).toBe(false);
      const clear = mockHub.request.mock.calls.find(([m]) => m === 'session.clearInputDraftIf');
      expect(clear).toBeTruthy();
      expect(getCalls).toBeGreaterThanOrEqual(2);
    });

    it('falls back to the normal save when the backup write fails (storage full)', () => {
      // localStorage refuses the draft-backup write (disabled / quota): the
      // suppression alone would leave the typed text only in the composer
      // signal — lost to a switch, reload, or close. The normal save runs
      // instead; the daemon folds any merged transcripts via the echoed draft
      // version, so the fallback is transcript-safe.
      const baseStorage = createMemoryStorage();
      const quotaStorage = createMemoryStorage();
      quotaStorage.setItem = (k: string, v: string) => {
        if (k.startsWith('hyperneo_voice_transcript_outbox_v1.draft.')) {
          throw new DOMException('quota', 'QuotaExceededError');
        }
        baseStorage.setItem(k, v);
      };
      globalThis.localStorage = quotaStorage as Storage;
      mockHub.request.mockResolvedValue({ session: { metadata: { inputDraft: '' } } });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      result.current.setContent('typed while landing live');
      markVoiceTranscriptLanded('session-1', 'voice');
      return act(async () => {
        await vi.runAllTimersAsync();
      }).then(() => {
        const save = mockHub.request.mock.calls.find(
          ([m, d]) =>
            m === 'session.update' &&
            d?.sessionId === 'session-1' &&
            d?.metadata?.inputDraft === 'typed while landing live'
        );
        expect(save).toBeTruthy();
      });
    });

    it('advances the cached draft version from acknowledged saves', async () => {
      // A concurrent daemon-side bump (another tab's folded save) must not
      // leave this composer echoing a stale version forever — every later
      // edit would then be folded as stale, duplicating the transcript the
      // local draft already contains. The save's ack carries the APPLIED
      // version and the cache advances.
      let version = 1;
      mockHub.request.mockImplementation(
        async (method: string, payload?: { expectedDraftVersion?: number }) => {
          if (method === 'session.get') {
            return { session: { metadata: { inputDraft: '', inputDraftVersion: version } } };
          }
          if (method === 'session.update') {
            version += 1;
            return { success: true, draftVersion: version };
          }
          return {};
        }
      );
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      result.current.setContent('first edit');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      // The acknowledged save advanced the daemon version to 2; the NEXT save
      // must echo 2 — not the stale get-time version 1.
      result.current.setContent('second edit');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const saves = mockHub.request.mock.calls.filter(([m]) => m === 'session.update');
      expect(saves[saves.length - 1][1]?.expectedDraftVersion).toBe(2);
    });

    it('adopts a folded save ack when the composer still shows the sent content', async () => {
      // The backup write failed, so the fallback save is STALE — the daemon
      // folds the merged transcript into it and returns the applied value.
      // The composer adopts that value (its content lacked the transcript);
      // advancing the version WITHOUT adopting would let the next edit apply
      // as-is and clear the baseline, deleting the transcript.
      const quotaStorage = createMemoryStorage();
      const baseStorage = createMemoryStorage();
      quotaStorage.setItem = (k: string, v: string) => {
        if (k.startsWith('hyperneo_voice_transcript_outbox_v1.draft.')) {
          throw new DOMException('quota', 'QuotaExceededError');
        }
        baseStorage.setItem(k, v);
      };
      globalThis.localStorage = quotaStorage as Storage;
      mockHub.request.mockImplementation(
        async (method: string, payload?: { metadata?: { inputDraft?: string | null } }) => {
          if (method === 'session.get') {
            return { session: { metadata: { inputDraft: '' } } };
          }
          if (method === 'session.update' && payload?.metadata?.inputDraft === 'typed text') {
            return { success: true, draftVersion: 2, draftValue: 'typed text voice' };
          }
          return { success: true };
        }
      );
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      result.current.setContent('typed text');
      markVoiceTranscriptLanded('session-1', 'voice');
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The folded value was adopted into the composer.
      expect(result.current.content).toBe('typed text voice');
    });

    it('never moves the cached draft version backward', async () => {
      // A newer save acknowledged version 5; a LATE, out-of-order
      // acknowledgement for an older overlapping save carries version 4 —
      // assigning it unconditionally would regress the cache and misclassify
      // the next save as stale (folding a transcript the draft contains).
      let saveAcks = 0;
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return { session: { metadata: { inputDraft: 'seed', inputDraftVersion: 3 } } };
        }
        saveAcks += 1;
        // First save acks 4, second acks 5 — the cache should reach 5.
        return { success: true, draftVersion: saveAcks === 1 ? 4 : 5 };
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1', 50));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        result.current.setContent('first');
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        result.current.setContent('second');
        await vi.runAllTimersAsync();
      });
      expect(saveAcks).toBe(2);
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return { session: { metadata: { inputDraft: 'seed', inputDraftVersion: 5 } } };
        }
        // The stale, out-of-order acknowledgement.
        return { success: true, draftVersion: 4 };
      });
      await act(async () => {
        result.current.setContent('third');
        await vi.runAllTimersAsync();
      });
      // The cache kept 5 — the next save echoes it, not the regressed 4.
      await act(async () => {
        result.current.setContent('fourth');
        await vi.runAllTimersAsync();
      });
      const saves = mockHub.request.mock.calls.filter(([m]) => m === 'session.update');
      expect(saves[saves.length - 1][1]?.expectedDraftVersion).toBe(5);
    });

    it('recognizes an owed strip that committed with a lost ack (no transcript clear)', async () => {
      // The strip COMMITTED but its response was lost: the server draft is
      // transcript-only and the baseline is gone, while this tab's tombstone
      // still owes the clear. The reconcile must adopt the draft instead of
      // falling into the no-baseline conditional clear, which would delete
      // the voice input the strip preserved.
      saveClearTombstone('session-1', 3);
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return {
            session: {
              metadata: { inputDraft: 'voice', inputDraftVoiceLastStrippedSeq: 3 },
            },
          };
        }
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.content).toBe('voice');
      expect(hasClearTombstone('session-1')).toBe(false);
      // No conditional clear was issued against the transcript-only draft.
      const clearCall = mockHub.request.mock.calls.find(
        ([m, d]) => m === 'session.clearInputDraftIf' && d?.sessionId === 'session-1'
      );
      expect(clearCall).toBeFalsy();
    });

    it('recovers a fresh backup whose landing marker expired, folding the merged transcripts', async () => {
      // Reload with the landing marker long pruned (>24h) but the draft
      // backup refreshed an hour ago: the user's edits must not die with the
      // marker. The daemon's baseline snapshot separates the merged
      // transcripts from the stale baseline, so the restore folds BOTH into
      // the composer instead of clobbering the transcript with the
      // transcript-free backup.
      saveDraftBackup('session-1', 'user edits', 1);
      const backupClaim = peekExpiredDraftBackup('session-1');
      mockHub.request.mockResolvedValueOnce({
        session: {
          metadata: { inputDraft: 'old draft voice text', inputDraftVoiceBaseline: 'old draft' },
        },
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.content).toBe('user edits voice text');
      // The durable backup retired once its edits (plus transcripts) reached
      // the composer — the enabled saves now own them.
      expect(peekExpiredDraftBackup('session-1')).toBeNull();
      expect(backupClaim).not.toBeNull();
    });

    it('keeps the server draft when an expired backup cannot be reconciled (no baseline)', async () => {
      // Same reload, but no baseline snapshot survives (never staged, or a
      // strip already cleared it): the transcripts cannot be located, so
      // restoring the transcript-free backup would clobber them. The server
      // draft wins; the durable backup stays for the departed-session flush,
      // whose daemon-side merge folds-or-declines atomically.
      saveDraftBackup('session-1', 'user edits', 1);
      const backupClaim = peekExpiredDraftBackup('session-1');
      mockHub.request.mockResolvedValueOnce({
        session: { metadata: { inputDraft: 'merged draft' } },
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.content).toBe('merged draft');
      expect(peekExpiredDraftBackup('session-1')?.content).toBe('user edits');
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

  describe('review-hardening round', () => {
    it('issues the merging refresh itself when the initial get cannot prove the merge', async () => {
      // A landing raced the initial load's REQUEST (another tab's flush merged
      // after it was sent): the response shows no baseline snapshot and its
      // draft does not end with the landing aggregate — consuming here would
      // hide the transcript, so the settle path must issue the merging get and
      // consume only on its full merge.
      markVoiceTranscriptLanded('session-1', 'voice');
      mockHub.request
        .mockResolvedValueOnce({ session: { metadata: { inputDraft: 'hello' } } }) // initial
        .mockResolvedValueOnce({
          session: {
            metadata: { inputDraft: 'hello voice', inputDraftVoiceBaseline: 'hello' },
          },
        }); // the settle path's own refresh
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The initial get could not prove the merge — the landing survived it…
      expect(mockHub.request.mock.calls.filter(([m]) => m === 'session.get')).toHaveLength(2);
      // …and the refresh's full merge applied the draft and consumed it.
      expect(result.current.content).toBe('hello voice');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(false);
    });

    it('keeps the landing deferred when backup + transcripts cannot fit the draft limit', async () => {
      // appendDraftText silently slices at the character limit: a truncated
      // fold adopted here would let the re-enabled saves overwrite the complete
      // server draft, permanently dropping the transcript's tail. The landing
      // must stay deferred (saves suppressed into the backup) instead.
      markVoiceTranscriptLanded('session-1', 'voice words here');
      const longBackup = 'a'.repeat(99_999);
      saveDraftBackup(
        'session-1',
        longBackup,
        voiceTranscriptLandedSignal.value.get('session-1') ?? 1
      );
      mockHub.request.mockResolvedValue({
        session: {
          metadata: {
            inputDraft: `${longBackup} voice words here`,
            inputDraftVoiceBaseline: longBackup,
          },
        },
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The backup restores unchanged; the landing stays pending and the
      // durable backup survives (nothing consumed or retired).
      expect(result.current.content).toBe(longBackup);
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(true);
      expect(peekExpiredDraftBackup('session-1')?.content).toBe(longBackup);
    });

    it('does not double-fold transcripts a cancelled refresh already folded before the strip', async () => {
      // The clear chain's get is cancelled by typing; its reconcile-on-cancel
      // fold merges the transcripts into the typing and records the generation.
      // The chain's strip then acknowledges — appending the stripped value
      // AGAIN would duplicate the voice text.
      const gets: Array<{ resolve: (value: unknown) => void }> = [];
      mockHub.request.mockImplementation((method: string) => {
        if (method === 'session.get') {
          let resolve!: (value: unknown) => void;
          const promise = new Promise((r) => {
            resolve = r;
          });
          gets.push({ resolve });
          return promise;
        }
        if (method === 'session.stripVoiceBaseline') {
          return Promise.resolve({ updated: true, value: 'voice' });
        }
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        gets[0]?.resolve({ session: { metadata: { inputDraft: 'sent text' } } });
        await vi.runAllTimersAsync();
      });
      // A live landing defers behind the user's text; the user then sends.
      result.current.setContent('sent text');
      markVoiceTranscriptLanded('session-1', 'voice');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      // The clear starts the chain (its get #2 stays in flight), and typing
      // begins before that get resolves — cancelling its effect run.
      result.current.clear();
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(gets.length).toBe(2);
      result.current.setContent('new typing');
      await act(async () => {
        gets[1]?.resolve({
          session: {
            metadata: {
              inputDraft: 'sent text voice',
              inputDraftVoiceBaseline: 'sent text',
              inputDraftVoiceBaselineSeq: 1,
            },
          },
        });
        await vi.runAllTimersAsync();
      });

      // The cancelled get folded the transcript into the typing exactly once —
      // the strip's acknowledgement must not append a second occurrence.
      expect(result.current.content).toBe('new typing voice');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(false);
      expect(hasClearTombstone('session-1')).toBe(false);
    });

    it('restores a backup written AFTER the tombstone (post-clear typing)', async () => {
      // The user sent/cleared (owed clear, tombstone armed) and kept typing —
      // that newer backup is post-clear user state and must be restored, not
      // discarded with the pre-clear copies the scan skips.
      saveClearTombstone('session-1');
      // Age the tombstone below the backup the user writes afterwards.
      const tombstoneKeys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) ?? '';
        if (key.startsWith('hyperneo_voice_transcript_outbox_v1.clear.session-1.')) {
          tombstoneKeys.push(key);
        }
      }
      for (const key of tombstoneKeys) {
        const parsed = JSON.parse(localStorage.getItem(key) ?? '{}');
        localStorage.setItem(key, JSON.stringify({ ...parsed, ts: parsed.ts - 1000 }));
      }
      saveDraftBackup('session-1', 'post-clear typing', 1);
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') return { session: { metadata: { inputDraft: '' } } };
        if (method === 'session.clearInputDraftIf') return { cleared: true };
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.content).toBe('post-clear typing');
      // The owed clear reconciled against the (empty) daemon draft and retired.
      expect(hasClearTombstone('session-1')).toBe(false);
    });

    it('retires a backup whose merge lost the draft-version race instead of requeueing it', async () => {
      // The daemon's expectedDraftVersion guard reports {merged:false,
      // stale:true}: a newer committed write superseded this backup — pushing it
      // again would overwrite the newer draft, and requeueing would retry an
      // eternally-stale claim. It must be retired (with its supersede record).
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get')
          return { session: { metadata: { inputDraft: 'sent earlier' } } };
        if (method === 'session.mergeVoiceDraftBackup') return { merged: false, stale: true };
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result, rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId), {
        initialProps: { sessionId: 'session-1' },
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      saveDraftBackup('session-1', 'user edits', 1);
      rerender({ sessionId: 'session-2' });
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The stale-declined claim retired under its supersede record…
      expect(peekExpiredDraftBackup('session-1')).toBeNull();
      const supersedeKeys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) ?? '';
        if (key.startsWith('hyperneo_voice_transcript_outbox_v1.superseded.session-1.')) {
          supersedeKeys.push(key);
        }
      }
      expect(supersedeKeys.length).toBeGreaterThan(0);
      // …and was never requeued (exactly one merge attempt).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(70_000);
      });
      const merges = mockHub.request.mock.calls.filter(
        ([m]) => m === 'session.mergeVoiceDraftBackup'
      );
      expect(merges).toHaveLength(1);
    });

    it('re-arms the bounded retry after a strip rejects while still connected', async () => {
      // A strip rejection while CONNECTED never re-fires the connection
      // subscription (it only fires on CHANGES) and no content change follows —
      // without an explicit kick, the owed clear would idle until a reload.
      connectionState.value = 'connected';
      let strips = 0;
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
          strips += 1;
          if (strips === 1) throw new Error('Request timeout');
          return { updated: true, value: 'voice' };
        }
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      // Arm the tombstone AFTER mount: the connection subscription calls the
      // retry once immediately, and a pre-existing tombstone would let that
      // call run a SECOND reconcile beside the settle path's own.
      saveClearTombstone('session-1', 5);
      // A bounded advance settles the initial chain WITHOUT firing the 5s
      // bounded retry the rejection arms.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      // The reconcile's strip rejected while connected — the owed clear stays.
      expect(hasClearTombstone('session-1')).toBe(true);
      expect(strips).toBe(1);

      // The kicked bounded retry (5s) re-runs the reconcile — the strip now
      // commits and the tombstone retires without any connection change.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(strips).toBe(2);
      expect(hasClearTombstone('session-1')).toBe(false);
      expect(result.current.content).toBe('voice');
    });

    it('binds the deferred retirement to the save that captured the claim, not an earlier in-flight one', async () => {
      // A pre-landing save is still awaiting its ack when the reload
      // reconciliation folds a backup and defers a NEWER claim's retirement.
      // The old acknowledgement persisted pre-landing content — flushing the
      // current entry would delete the newer fold's only durable copy before
      // anything persisted it.
      const saveAcks: Array<{ content: string; resolve: (v: unknown) => void }> = [];
      let getCount = 0;
      mockHub.request.mockImplementation(
        (method: string, data?: { metadata?: { inputDraft?: string | null } }) => {
          if (method === 'session.get') {
            getCount += 1;
            if (getCount === 2) {
              // The switch-back load merges the pending server-side.
              return Promise.resolve({
                session: {
                  metadata: { inputDraft: 'typed voice', inputDraftVoiceBaseline: 'typed' },
                },
              });
            }
            return Promise.resolve({ session: { metadata: { inputDraft: '' } } });
          }
          if (method === 'session.update') {
            const content = data?.metadata?.inputDraft ?? '<null>';
            return new Promise((resolve) => {
              saveAcks.push({ content, resolve });
            });
          }
          if (method === 'session.mergeVoiceDraftBackup') return Promise.resolve({ merged: false });
          return {};
        }
      );
      const resolveSave = (content: string) => {
        for (const entry of saveAcks.filter((s) => s.content === content)) {
          entry.resolve({ success: true });
        }
      };
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const first = renderHook(({ sessionId }) => useInputDraft(sessionId), {
        initialProps: { sessionId: 'session-1' },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      // Type → save #1 fires and stays in flight.
      first.result.current.setContent('typed');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(saveAcks.some((s) => s.content === 'typed')).toBe(true);

      // A landing defers the edits into a backup; the page then RELOADS — the
      // fresh initial load merges server-side and the settle path folds
      // backup + transcript, deferring the NEWER claim's retirement to its
      // own save.
      markVoiceTranscriptLanded('session-1', 'voice');
      saveDraftBackup(
        'session-1',
        'typed edits',
        voiceTranscriptLandedSignal.value.get('session-1') ?? 1
      );
      await act(async () => {
        first.unmount();
      });
      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(result.current.content).toBe('typed edits voice');
      expect(peekExpiredDraftBackup('session-1')).not.toBeNull();

      // The PRE-LANDING save's acknowledgement must NOT retire the new claim.
      await act(async () => {
        resolveSave('typed');
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(peekExpiredDraftBackup('session-1')).not.toBeNull();

      // The post-fold save acknowledged the combined draft — it retires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(saveAcks.some((s) => s.content === 'typed edits voice')).toBe(true);
      await act(async () => {
        resolveSave('typed edits voice');
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(peekExpiredDraftBackup('session-1')).toBeNull();
    });

    it('folds the lost-ack stripped transcripts into restored post-clear typing', async () => {
      // The owed strip COMMITTED but its ack was lost (LastStrippedSeq matches
      // the versioned tombstone), and the settle path restored the user's
      // POST-CLEAR typing — newer state the daemon draft must not overwrite.
      // Retiring the tombstone without folding the transcript-only daemon
      // draft would let the next ordinary save discard the voice text.
      saveClearTombstone('session-1', 1);
      // Age the tombstone below the post-clear backup the user wrote after it.
      const tombstoneKeys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) ?? '';
        if (key.startsWith('hyperneo_voice_transcript_outbox_v1.clear.session-1.')) {
          tombstoneKeys.push(key);
        }
      }
      for (const key of tombstoneKeys) {
        const parsed = JSON.parse(localStorage.getItem(key) ?? '{}');
        localStorage.setItem(key, JSON.stringify({ ...parsed, ts: parsed.ts - 1000 }));
      }
      saveDraftBackup('session-1', 'post-clear typing', 1);
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return {
            session: {
              metadata: { inputDraft: 'voice', inputDraftVoiceLastStrippedSeq: 1 },
            },
          };
        }
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The restored typing carries the transcripts; the tombstone retired.
      expect(result.current.content).toBe('post-clear typing voice');
      expect(hasClearTombstone('session-1')).toBe(false);
    });

    it('never folds an old session transcript into the composer of a new session', async () => {
      // The owed-clear reconcile's session.get resolves AFTER the hook moved
      // to another session: the shared signal now backs the NEW composer, and
      // appending the old session's transcript would contaminate it (and its
      // next save would persist the foreign text).
      const gets: Array<{ resolve: (value: unknown) => void }> = [];
      mockHub.request.mockImplementation((method: string) => {
        if (method === 'session.get') {
          let resolve!: (value: unknown) => void;
          const promise = new Promise((r) => {
            resolve = r;
          });
          gets.push({ resolve });
          return promise;
        }
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      // Tombstone versioned with the sequence the daemon already stripped.
      saveClearTombstone('session-1', 1);
      const { result, rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId), {
        initialProps: { sessionId: 'session-1' },
      });
      await act(async () => {
        gets[0]?.resolve({
          session: { metadata: { inputDraft: '', inputDraftVoiceLastStrippedSeq: 1 } },
        });
        await vi.runAllTimersAsync();
      });
      // The user switches BEFORE the reconcile's get resolves; the new
      // composer holds its own typing.
      rerender({ sessionId: 'session-2' });
      result.current.setContent('new session typing');
      await act(async () => {
        gets[1]?.resolve({
          // The OLD session's transcript-only draft (strip committed, ack lost).
          session: { metadata: { inputDraft: 'old voice', inputDraftVoiceLastStrippedSeq: 1 } },
        });
        await vi.runAllTimersAsync();
      });
      // The new session's composer is untouched…
      expect(result.current.content).toBe('new session typing');
      // …and the old session's owed clear is satisfied server-side.
      expect(hasClearTombstone('session-1')).toBe(false);
    });

    it('keeps the owed clear when the post-clear fold would truncate', async () => {
      // The stripped transcripts plus the restored post-clear typing exceed
      // the draft limit: appendDraftText would silently truncate, and folding
      // anyway would let the next save drop the transcript's tail. The clear
      // stays owed (its versioned tombstone recognizes the committed strip on
      // retry) until the complete combination fits.
      saveClearTombstone('session-1', 1);
      const tombstoneKeys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) ?? '';
        if (key.startsWith('hyperneo_voice_transcript_outbox_v1.clear.session-1.')) {
          tombstoneKeys.push(key);
        }
      }
      for (const key of tombstoneKeys) {
        const parsed = JSON.parse(localStorage.getItem(key) ?? '{}');
        localStorage.setItem(key, JSON.stringify({ ...parsed, ts: parsed.ts - 1000 }));
      }
      const longBackup = 'a'.repeat(99_995);
      saveDraftBackup('session-1', longBackup, 1);
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return {
            session: {
              metadata: {
                inputDraft: 'a long stripped transcript tail that cannot fit',
                inputDraftVoiceLastStrippedSeq: 1,
              },
            },
          };
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

      // The restored typing stands UNTRUNCATED (no silent tail drop)…
      expect(result.current.content).toBe(longBackup);
      // …and the tombstone stays owed for the bounded retry.
      expect(hasClearTombstone('session-1')).toBe(true);
    });

    it('retires the restored post-clear backup only after its combined save is acknowledged', async () => {
      // The restored claim is transcript-free user typing: leaving it as the
      // freshest durable claim would let a later switch push it over the
      // combined draft. The deferred retirement binds it to the first
      // acknowledged save of the folded content.
      saveClearTombstone('session-1', 1);
      const tombstoneKeys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) ?? '';
        if (key.startsWith('hyperneo_voice_transcript_outbox_v1.clear.session-1.')) {
          tombstoneKeys.push(key);
        }
      }
      for (const key of tombstoneKeys) {
        const parsed = JSON.parse(localStorage.getItem(key) ?? '{}');
        localStorage.setItem(key, JSON.stringify({ ...parsed, ts: parsed.ts - 1000 }));
      }
      saveDraftBackup('session-1', 'post-clear typing', 1);
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return {
            session: {
              metadata: { inputDraft: 'voice', inputDraftVoiceLastStrippedSeq: 1 },
            },
          };
        }
        return { success: true };
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      // A second drain fires the post-fold debounced save (the fold applies
      // during the settle callback, scheduling the save at act-exit).
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      // The combined content saved and was acknowledged — the claim retired.
      const saves = mockHub.request.mock.calls.filter(([m]) => m === 'session.update');
      expect(saves.length).toBeGreaterThan(0);
      expect(peekExpiredDraftBackup('session-1')).toBeNull();
    });

    it('keeps the durable backup when an active-content merge comes back stale', async () => {
      // STALE only means another tab's newer write superseded the PUSH — this
      // tab's active edits are still only scheduled through their normal
      // debounced save. Retiring the backup would delete the only durable
      // copy before ANY acknowledged save of that content.
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') return { session: { metadata: {} } };
        if (method === 'session.mergeVoiceDraftBackup') return { merged: false, stale: true };
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
      // A deferred landing suppresses saves into a backup, then the user
      // switches away — the claim queues — and RETURNS before the retry
      // fires, typing newer content over the restored backup.
      markVoiceTranscriptLanded('session-1', 'voice');
      result.current.setContent('older edits');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(getDraftBackup('session-1')).toBe('older edits');
      rerender({ sessionId: 'session-2' });
      await act(async () => {
        // Bounded: the queued claim's 5s retry must fire AFTER the return,
        // while session-1 is current — runAllTimers would flush it here as a
        // DEPARTED push instead.
        await vi.advanceTimersByTimeAsync(100);
      });
      await act(async () => {
        rerender({ sessionId: 'session-1' });
      });
      result.current.setContent('newer typing');
      await act(async () => {
        // The queued claim's retry fires while the session is CURRENT with
        // non-empty content — the ACTIVE-content merge path.
        await vi.advanceTimersByTimeAsync(7_000);
      });
      const mergesAfterFirst = mockHub.request.mock.calls.filter(
        ([m]) => m === 'session.mergeVoiceDraftBackup'
      ).length;
      expect(mergesAfterFirst).toBeGreaterThan(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      const mergesAfterSecond = mockHub.request.mock.calls.filter(
        ([m]) => m === 'session.mergeVoiceDraftBackup'
      ).length;
      // The requeued ACTIVE content retried after the backoff…
      expect(mergesAfterSecond).toBeGreaterThan(mergesAfterFirst);
      // …and the durable copy of the edits survived every stale decline.
      expect(peekExpiredDraftBackup('session-1')).not.toBeNull();
    });

    it('queues refused-fold text as an in-memory claim when the user switches away', async () => {
      // localStorage refused the backup and the daemon refused the fold (too
      // long to carry the transcripts): the composer was the only copy. The
      // switch must queue an in-memory merge retry instead of abandoning it.
      const baseStorage = createMemoryStorage();
      const quotaStorage = createMemoryStorage();
      quotaStorage.setItem = (k: string, v: string) => {
        if (k.startsWith('hyperneo_voice_transcript_outbox_v1.draft.')) {
          throw new DOMException('quota', 'QuotaExceededError');
        }
        baseStorage.setItem(k, v);
      };
      quotaStorage.getItem = (k: string) => baseStorage.getItem(k);
      quotaStorage.removeItem = (k: string) => void baseStorage.removeItem(k);
      globalThis.localStorage = quotaStorage as Storage;
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') return { session: { metadata: { inputDraft: '' } } };
        if (method === 'session.update') {
          return { success: true, draftVersion: 9, draftValue: 'old merged', foldRefused: true };
        }
        if (method === 'session.mergeVoiceDraftBackup') {
          // The in-memory claim's retry eventually commits.
          return { merged: true, value: 'merged with transcripts' };
        }
        return { success: true };
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result, rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId), {
        initialProps: { sessionId: 'session-1' },
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      markVoiceTranscriptLanded('session-1', 'voice');
      result.current.setContent('long refused text');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      rerender({ sessionId: 'session-2' });
      await act(async () => {
        // The switch queued the in-memory claim (its kick no-ops while the
        // connection is down).
        await vi.advanceTimersByTimeAsync(100);
      });
      await act(async () => {
        // Reconnecting fires the retry pass, whose merge commits and drains.
        connectionState.value = 'connected';
        await vi.advanceTimersByTimeAsync(100);
      });
      // The switch queued an in-memory claim for the departed session's text,
      // and its merge carried the content.
      const merges = mockHub.request.mock.calls.filter(
        ([m]) => m === 'session.mergeVoiceDraftBackup'
      );
      expect(merges.length).toBeGreaterThan(0);
      expect(merges.some(([, data]) => data?.content === 'long refused text')).toBe(true);
    });

    it('folds a guarded refresh into post-clear typing instead of dropping the transcript', async () => {
      // The live owed-clear chain sees a RETAINED pending (draft too full):
      // it clears the stale baseline conditionally, then refreshes so the
      // pending merges onto the clean draft. The refresh's apply guard
      // refuses application over the restored post-clear typing — consuming
      // the landing without folding would let the next ordinary save
      // overwrite the transcript-only daemon draft.
      markVoiceTranscriptLanded('session-1', 'voice');
      const gen = voiceTranscriptLandedSignal.value.get('session-1') ?? 1;
      saveClearTombstone('session-1');
      const tombstoneKeys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) ?? '';
        if (key.startsWith('hyperneo_voice_transcript_outbox_v1.clear.session-1.')) {
          tombstoneKeys.push(key);
        }
      }
      for (const key of tombstoneKeys) {
        const parsed = JSON.parse(localStorage.getItem(key) ?? '{}');
        localStorage.setItem(key, JSON.stringify({ ...parsed, ts: parsed.ts - 1000 }));
      }
      saveDraftBackup('session-1', 'post-clear typing', gen);
      let gets = 0;
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          gets += 1;
          if (gets === 1) return { session: { metadata: { inputDraft: 'sent text' } } };
          if (gets === 2) {
            // The chain's first get: the pending is RETAINED (draft too full).
            return {
              session: {
                metadata: { inputDraft: 'sent text', inputDraftVoicePending: 'voice' },
              },
            };
          }
          // The post-clear refresh: the pending merged onto the cleared draft.
          return {
            session: { metadata: { inputDraft: 'voice', inputDraftVoiceBaseline: '' } },
          };
        }
        if (method === 'session.clearInputDraftIf') return { cleared: true };
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

      // The typing carries the merged transcript, and the clear settled.
      expect(result.current.content).toBe('post-clear typing voice');
      expect(hasClearTombstone('session-1')).toBe(false);
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(false);
    });

    it('keeps local content and a stale version cache when the daemon refuses a truncating fold', async () => {
      // localStorage failed (no backup), so the save fell through to the
      // daemon with text too long to fold the transcripts into. The refused
      // ack must NOT adopt the retained older draft over the never-persisted
      // typing, and must NOT advance the version cache (the next save would
      // then apply as-is and clear the baseline).
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return { session: { metadata: { inputDraft: '' } } };
        }
        if (method === 'session.update') {
          return {
            success: true,
            draftVersion: 4,
            draftValue: 'old merged draft',
            foldRefused: true,
          };
        }
        return {};
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      result.current.setContent('y'.repeat(5_000));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      // A further edit saves again — still refused, still unadopted.
      result.current.setContent('y'.repeat(4_999));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The unsaved text survived the refused ack…
      expect(result.current.content).toBe('y'.repeat(4_999));
      // …and the version cache stayed STALE: every save echoes no version.
      const saves = mockHub.request.mock.calls.filter(([m]) => m === 'session.update');
      expect(saves.length).toBeGreaterThan(1);
      expect(saves.every(([, data]) => data?.expectedDraftVersion === undefined)).toBe(true);
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

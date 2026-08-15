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
  peekExpiredDraftBackup,
  resetVoiceTranscriptOutbox,
  saveDraftBackup,
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
      expect(peekExpiredDraftBackup('session-1')).toBeNull();
      // The landing was settled by the INITIAL load — no second refresh get
      // raced the restore.
      expect(mockHub.request.mock.calls.filter(([m]) => m === 'session.get')).toHaveLength(1);
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

// @ts-nocheck

import { renderHook, act } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useInputDraft } from '../useInputDraft.ts';
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

    it('refreshes the mounted draft when the outbox lands a transcript for its session', async () => {
      mockHub.request.mockResolvedValueOnce({ session: { metadata: { inputDraft: '' } } });
      mockHub.request.mockResolvedValue({ session: { metadata: { inputDraft: 'transcript' } } });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('');

      voiceTranscriptLandedSignal.value = new Map([['session-1', 1]]);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

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

      expect(result.current.content).toBe('user typing');
    });

    it('defers the outbox refresh until an active composer is cleared, then applies it', async () => {
      mockHub.request
        .mockResolvedValueOnce({ session: { metadata: { inputDraft: '' } } })
        .mockResolvedValueOnce({ session: { metadata: { inputDraft: 'transcript' } } })
        .mockResolvedValueOnce({ updated: true, value: 'transcript' });
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
      expect(result.current.content).toBe('user typing');
      expect(mockHub.request.mock.calls.filter(([m]) => m === 'session.get')).toHaveLength(1);

      result.current.clear();
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(mockHub.request.mock.calls.filter(([m]) => m === 'session.get')).toHaveLength(2);
      expect(result.current.content).toBe('transcript');
    });

    it('keeps the landing pending when the refresh get fails, then applies it on a later trigger', async () => {
      mockHub.request
        .mockResolvedValueOnce({ session: { metadata: { inputDraft: '' } } })
        .mockRejectedValueOnce(new Error('socket closed'))
        .mockResolvedValue({ session: { metadata: { inputDraft: 'transcript' } } });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('');

      voiceTranscriptLandedSignal.value = new Map([['session-1', 1]]);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(true);

      voiceTranscriptLandedSignal.value = new Map([['session-1', 1]]);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('transcript');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(false);
    });

    it('retries a failed refresh when the connection is restored', async () => {
      mockHub.request
        .mockResolvedValueOnce({ session: { metadata: { inputDraft: '' } } })
        .mockRejectedValueOnce(new Error('socket closed'))
        .mockResolvedValue({ session: { metadata: { inputDraft: 'transcript' } } });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      connectionState.value = 'disconnected';

      voiceTranscriptLandedSignal.value = new Map([['session-1', 1]]);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(true);

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
        .mockResolvedValueOnce({ session: { metadata: { inputDraft: '' } } })
        .mockResolvedValueOnce({
          session: { metadata: { inputDraft: 'full', inputDraftVoicePending: 'transcript' } },
        })
        .mockResolvedValue({
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

      result.current.setContent('A text');
      voiceTranscriptLandedSignal.value = new Map([
        ['session-A', 1],
        ['session-B', 1],
      ]);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

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

      rerender({ s: 'session-B' });
      await act(async () => {
        await vi.runAllTimersAsync();
      });

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
        .mockResolvedValueOnce({ session: { metadata: { inputDraft: '' } } })
        .mockRejectedValueOnce(new Error('socket closed'))
        .mockResolvedValueOnce({
          session: { metadata: { inputDraft: 'text to send transcript' } },
        })
        .mockResolvedValue({ updated: true, value: 'transcript' });
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
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(true);
      expect(
        mockHub.request.mock.calls.filter(([m]) => m === 'session.stripVoiceBaseline')
      ).toHaveLength(0);
      expect(
        mockHub.request.mock.calls.filter(([m]) => m === 'session.clearInputDraftIf')
      ).toHaveLength(0);

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
      expect(getDraftBackup('session-1')).toBe('editing');
      expect(mockHub.request.mock.calls.filter(([m]) => m === 'session.update')).toHaveLength(0);
    });

    it('folds the merged transcript into a restored draft backup on reload', async () => {
      markVoiceTranscriptLanded('session-1', 'voice');
      saveDraftBackup(
        'session-1',
        'hello world',
        voiceTranscriptLandedSignal.value.get('session-1') ?? 1
      );
      mockHub.request.mockResolvedValue({
        session: {
          metadata: { inputDraft: 'hello voice', inputDraftVoiceBaseline: 'hello' },
        },
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.content).toBe('hello world voice');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(false);
      expect(peekExpiredDraftBackup('session-1')).toBeNull();
      expect(mockHub.request.mock.calls.filter(([m]) => m === 'session.get')).toHaveLength(1);
    });

    it('does not fold or consume when the reload could not merge (pendingRetained)', async () => {
      markVoiceTranscriptLanded('session-1', 'voice');
      saveDraftBackup('session-1', 'hello world', 1);
      mockHub.request.mockResolvedValue({
        session: { metadata: { inputDraft: 'hello world', inputDraftVoicePending: 'voice' } },
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.content).toBe('hello world');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(true);
    });

    it('preserves every queued transcript when stripping a cleared baseline', async () => {
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return { session: { metadata: { inputDraft: 'baseline first second' } } };
        }
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
      markVoiceTranscriptLanded('session-1', 'hello');
      saveDraftBackup('session-1', 'hello', 1);
      mockHub.request.mockResolvedValue({
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
      await act(async () => {
        gets[0]?.resolve({ session: { metadata: { inputDraft: '' } } });
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        markVoiceTranscriptLanded('session-1', 'transcript');
      });
      expect(gets.length).toBe(2);

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
      expect(result.current.content).toBe('transcript');

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

      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
      rerender({ s: 'session-B' });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
      connectionState.value = 'connected';
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(mergeCalls).toBe(1);

      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(mergeCalls).toBeGreaterThanOrEqual(2);
      expect(peekExpiredDraftBackup('session-A')).toBeNull();
    });

    it('persists an owed clear across a reload via the tombstone (no backup resurrection)', async () => {
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
      expect(peekExpiredDraftBackup('session-1')).toBeNull();
      expect(hasClearTombstone('session-1')).toBe(true);
      first.unmount();

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
      expect(second.result.current.content).toBe('voice');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(false);
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

      expect(result.current.content).toBe('sent text voice');
      expect(hasClearTombstone('session-1')).toBe(true);
    });

    it('reconciles an owed clear directly when its landing expired (tombstone only)', async () => {
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
        .mockResolvedValueOnce({ session: { metadata: { inputDraft: '' } } })
        .mockImplementationOnce(
          () =>
            new Promise((r) => {
              resolveGet = r;
            })
        );
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      markVoiceTranscriptLanded('session-1', 'transcript');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        result.current.setContent('typing');
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        resolveGet({
          session: { metadata: { inputDraft: 'full', inputDraftVoicePending: 'transcript' } },
        });
        await vi.runAllTimersAsync();
      });
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

      markVoiceTranscriptLanded('session-1', 'new voice');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(strips()).toBe(1);
      expect(result.current.content).toBe('voice');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(true);
    });

    it('retries an owed clear even while the composer holds the merged draft', async () => {
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
      expect(hasClearTombstone('session-1')).toBe(true);
      expect(
        mockHub.request.mock.calls.filter(([m]) => m === 'session.stripVoiceBaseline').length
      ).toBeGreaterThan(0);

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
      result.current.setContent('sent text and more typing');
      await act(async () => {
        resolveStrip?.({ updated: true, value: 'voice' });
        await vi.runAllTimersAsync();
      });
      expect(result.current.content).toBe('sent text and more typing voice');
      expect(voiceTranscriptLandedSignal.value.has('session-1')).toBe(false);
    });

    it('versions an unversioned owed tombstone with the sequence before stripping', async () => {
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

      expect(hasClearTombstone('session-1')).toBe(true);
      expect(getClearTombstone('session-1')?.baselineSeq).toBe(2);
    });

    it('persists a pendingRetained expired-landing restore through an acknowledged merge', async () => {
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
      connectionState.value = 'connected';
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.content).toBe('user edits');
      expect(mergeCommitted).toBe(true);
      expect(peekExpiredDraftBackup('session-1')).toBeNull();
    });

    it('keeps the durable backup when the pendingRetained merge cannot commit', async () => {
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
      connectionState.value = 'connected';
      const { result, rerender } = renderHook(({ s }) => useInputDraft(s), {
        initialProps: { s: 'session-A' },
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      result.current.setContent('edits');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      saveDraftBackup('session-A', 'edits', 1);

      rerender({ s: 'session-B' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(attempts).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(peekExpiredDraftBackup('session-A')).toBeNull();
    });

    it('queues a live-landing backup for merge when the user switches away', async () => {
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

      rerender({ s: 'session-B' });
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
      result.current.setContent('stale edits v2');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      });

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
      expect(merge?.[1]?.content).toBe('newer typing');
      expect(peekExpiredDraftBackup('session-A')).toBeNull();
    });

    it('merges a RETAINED pending after the expired-landing clear (reconcileOwedClear)', async () => {
      saveClearTombstone('session-1');
      let getCalls = 0;
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          getCalls += 1;
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
      result.current.setContent('second edit');
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const saves = mockHub.request.mock.calls.filter(([m]) => m === 'session.update');
      expect(saves[saves.length - 1][1]?.expectedDraftVersion).toBe(2);
    });

    it('adopts a folded save ack when the composer still shows the sent content', async () => {
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

      expect(result.current.content).toBe('typed text voice');
    });

    it('never moves the cached draft version backward', async () => {
      let saveAcks = 0;
      mockHub.request.mockImplementation(async (method: string) => {
        if (method === 'session.get') {
          return { session: { metadata: { inputDraft: 'seed', inputDraftVersion: 3 } } };
        }
        saveAcks += 1;
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
        return { success: true, draftVersion: 4 };
      });
      await act(async () => {
        result.current.setContent('third');
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        result.current.setContent('fourth');
        await vi.runAllTimersAsync();
      });
      const saves = mockHub.request.mock.calls.filter(([m]) => m === 'session.update');
      expect(saves[saves.length - 1][1]?.expectedDraftVersion).toBe(5);
    });

    it('recognizes an owed strip that committed with a lost ack (no transcript clear)', async () => {
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
      const clearCall = mockHub.request.mock.calls.find(
        ([m, d]) => m === 'session.clearInputDraftIf' && d?.sessionId === 'session-1'
      );
      expect(clearCall).toBeFalsy();
    });

    it('recovers a fresh backup whose landing marker expired, folding the merged transcripts', async () => {
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
      expect(peekExpiredDraftBackup('session-1')).toBeNull();
      expect(backupClaim).not.toBeNull();
    });

    it('keeps the server draft when an expired backup cannot be reconciled (no baseline)', async () => {
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
        .mockResolvedValueOnce({ session: { metadata: { inputDraft: '' } } })
        .mockImplementationOnce(
          () =>
            new Promise((r) => {
              resolveGet = r;
            })
        );
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

      const { result } = renderHook(() => useInputDraft('session-1'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      await act(async () => {
        markVoiceTranscriptLanded('session-1', 'transcript');
      });
      expect(resolveGet).toBeTypeOf('function');
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
      voiceTranscriptLandedSignal.value = new Map([['session-1', 1]]);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const saves = mockHub.request.mock.calls.filter(([m]) => m === 'session.update');
      expect(saves).toHaveLength(0);
    });

    it('does not apply a draft whose session.get resolved after the session changed', async () => {
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

      rerender({ sessionId: 'session-2' });

      await act(async () => {
        gets[0]?.resolve({ session: { metadata: { inputDraft: 'session-1 draft' } } });
        await vi.runAllTimersAsync();
      });

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
});

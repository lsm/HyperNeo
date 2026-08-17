// @ts-nocheck
/**
 * Session-switch adoption-flush test, ISOLATED in its own file.
 *
 * The rerender-inside-act this test requires (switching sessions before the
 * deferred save effect runs — the very interleave under test) leaves preact
 * test utils' act rAF restore wedged, which breaks signal-effect scheduling
 * for any test that follows in the same file. Keeping it structurally alone
 * is the invariant; a shared file would need a fragile "keep this LAST" note.
 */

import { act, renderHook } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionManager } from '../../lib/connection-manager.ts';
import { connectionState } from '../../lib/state.ts';
import { resetVoiceTranscriptOutbox } from '../../lib/voice/voice-transcript-outbox.ts';
import { useInputDraft } from '../useInputDraft.ts';

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

describe('useInputDraft session-switch adoption flush', () => {
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

  it('does not flush a stale pre-adoption draft over the adoption save on session switch', async () => {
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
    const calls = mockHub.onEvent.mock.calls.filter(([m]) => m === 'session.voiceLanded');
    expect(calls.length).toBeGreaterThan(0);
    const listener = calls[calls.length - 1][1];
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

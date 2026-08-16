// @ts-nocheck
/**
 * Isolated regression coverage for the failed-initial-load refresh (codex
 * round 11): a session.get that times out or transiently rejects while a
 * landing stays live must still retry the merging refresh.
 *
 * This lives in its OWN file deliberately: completing a replay-effect refresh
 * chain that only exists because the initial load failed leaves the
 * @preact/signals effect scheduler in a state where later useSignalEffect
 * subscriptions in the SAME module graph stop re-arming under vitest. File
 * isolation contains the interaction; the production flow is the same signal
 * write the tombstone settle path has always used.
 */
import { act, renderHook } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionManager } from '../../lib/connection-manager.ts';
import { connectionState } from '../../lib/state.ts';
import {
  markVoiceTranscriptLanded,
  resetVoiceTranscriptOutbox,
} from '../../lib/voice/voice-transcript-outbox.ts';
import { useInputDraft } from '../useInputDraft.ts';

vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHubIfConnected: vi.fn() },
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

describe('useInputDraft — failed initial load', () => {
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
    connectionState.value = 'connecting';
    vi.useRealTimers();
  });

  it('retries the live-landing refresh after the initial load fails', async () => {
    // The failed initial load still marks itself settled without touching
    // a single reactive value — the replay effect already exited at its
    // settled guard and nothing re-runs it. Re-trigger it so its refresh
    // get merges the staged transcript into the composer.
    let gets = 0;
    mockHub.request.mockImplementation(async (method: string) => {
      if (method === 'session.get') {
        gets += 1;
        if (gets === 1) throw new Error('transient timeout');
        return {
          session: { metadata: { inputDraft: 'merged voice', inputDraftVoiceBaseline: null } },
        };
      }
      return { success: true };
    });
    connectionState.value = 'connected';
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
    markVoiceTranscriptLanded('session-1', 'voice');

    const { result } = renderHook(() => useInputDraft('session-1'));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(gets).toBeGreaterThan(1);
    expect(result.current.content).toBe('merged voice');
  });
});

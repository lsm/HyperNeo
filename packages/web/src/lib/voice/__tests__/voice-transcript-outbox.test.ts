// @ts-nocheck
/**
 * Tests for the durable voice-transcript outbox: transcripts staged when the
 * daemon was unreachable during an unmounted voice delivery are parked in
 * localStorage and replayed through session.appendVoiceDraft (with a per-entry
 * dedupId) once the connection is restored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hubRequest = vi.fn(async () => ({ success: true }));

vi.mock('../../connection-manager', () => ({
  connectionManager: { getHubIfConnected: vi.fn(() => ({ request: hubRequest })) },
}));

import {
  enqueueTranscript,
  flushPendingTranscripts,
  getPendingTranscripts,
  removePendingTranscript,
  resetVoiceTranscriptOutbox,
  startVoiceTranscriptOutboxFlush,
  stopVoiceTranscriptOutboxFlush,
} from '../voice-transcript-outbox.ts';
import { connectionManager } from '../../connection-manager.ts';
import { connectionState } from '../../state.ts';

// happy-dom's localStorage is unreliable across module boundaries — stub the
// global with an in-memory Storage, the established pattern in this repo.
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

describe('voice transcript outbox', () => {
  beforeEach(() => {
    globalThis.localStorage = createMemoryStorage();
    resetVoiceTranscriptOutbox();
    hubRequest.mockClear();
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue({
      request: hubRequest,
    });
    connectionState.value = 'disconnected';
  });

  afterEach(() => {
    globalThis.localStorage = originalStorage;
    stopVoiceTranscriptOutboxFlush();
    vi.useRealTimers();
  });

  afterEach(() => {
    stopVoiceTranscriptOutboxFlush();
    vi.useRealTimers();
  });

  it('parks a transcript and reads it back', () => {
    enqueueTranscript('s1', 'hello world');
    const entries = getPendingTranscripts();
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe('s1');
    expect(entries[0].text).toBe('hello world');
    expect(typeof entries[0].id).toBe('string');
  });

  it('prunes to the entry cap (oldest dropped)', () => {
    for (let i = 0; i < 25; i++) enqueueTranscript('s1', `t${i}`);
    const entries = getPendingTranscripts();
    expect(entries.length).toBeLessThanOrEqual(20);
    // The newest survive.
    expect(entries[entries.length - 1].text).toBe('t24');
  });

  it('flushes entries through appendVoiceDraft with a dedupId and removes on ack', async () => {
    enqueueTranscript('s1', 'first');
    enqueueTranscript('s1', 'second');
    await flushPendingTranscripts();

    expect(hubRequest).toHaveBeenCalledTimes(2);
    const calls = hubRequest.mock.calls.map(([m, data]) => data);
    expect(calls.every((d) => d.sessionId === 's1')).toBe(true);
    expect(calls.every((d) => typeof d.dedupId === 'string' && d.dedupId.length > 0)).toBe(true);
    expect(getPendingTranscripts()).toHaveLength(0);
  });

  it('keeps an entry the daemon refused (retry later, bounded by TTL)', async () => {
    enqueueTranscript('s1', 'stuck');
    hubRequest.mockRejectedValueOnce(new Error('Pending voice draft is at the character limit'));
    await flushPendingTranscripts();
    expect(getPendingTranscripts()).toHaveLength(1);
  });

  it('removes an entry that the daemon reports as already merged (deduped ack)', async () => {
    enqueueTranscript('s1', 'already landed');
    hubRequest.mockResolvedValueOnce({ success: true, deduped: true });
    await flushPendingTranscripts();
    expect(getPendingTranscripts()).toHaveLength(0);
  });

  it('does nothing when the connection is down', async () => {
    enqueueTranscript('s1', 'waiting');
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
    await flushPendingTranscripts();
    expect(hubRequest).not.toHaveBeenCalled();
    expect(getPendingTranscripts()).toHaveLength(1);
  });

  it('auto-flushes when the connection (re)establishes', async () => {
    vi.useFakeTimers();
    enqueueTranscript('s1', 'queued while down');
    startVoiceTranscriptOutboxFlush();
    connectionState.value = 'connected';
    await vi.advanceTimersByTimeAsync(600);
    expect(hubRequest).toHaveBeenCalled();
    expect(getPendingTranscripts()).toHaveLength(0);
  });

  it('removePendingTranscript drops a single entry', () => {
    enqueueTranscript('s1', 'a');
    enqueueTranscript('s1', 'b');
    const [first] = getPendingTranscripts();
    removePendingTranscript(first.id);
    const rest = getPendingTranscripts();
    expect(rest).toHaveLength(1);
    expect(rest[0].text).toBe('b');
  });
});

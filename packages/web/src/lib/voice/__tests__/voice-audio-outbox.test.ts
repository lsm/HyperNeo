// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hubRequest = vi.fn(async () => ({ text: 'hello world' }));

vi.mock('../../connection-manager', () => ({
  connectionManager: { getHubIfConnected: vi.fn(() => ({ request: hubRequest })) },
}));

const listVoiceRecords = vi.hoisted(() => vi.fn(async () => []));
const deleteVoiceRecord = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../voice-audio-store.ts', () => ({
  listVoiceRecords,
  deleteVoiceRecord,
  putVoiceRecord: vi.fn(async () => true),
}));

import { connectionManager } from '../../connection-manager.ts';
import { connectionState } from '../../state.ts';
import {
  flushPendingVoiceAudio,
  markVoiceAudioBusy,
  pendingVoiceAudioRecords,
  resetVoiceAudioOutbox,
  startVoiceAudioOutboxFlush,
  stopVoiceAudioOutboxFlush,
} from '../voice-audio-outbox.ts';

function createEntry(overrides = {}) {
  return {
    id: 'rec-1',
    sessionId: 's1',
    audioBase64: 'aGk=',
    mimeType: 'audio/wav',
    peakLevel: 0.5,
    createdAt: 1_726_000_000_000,
    ...overrides,
  };
}

describe('voice audio outbox', () => {
  beforeEach(() => {
    resetVoiceAudioOutbox();
    hubRequest.mockReset().mockImplementation(async () => ({ text: 'hello world' }));
    vi.mocked(connectionManager.getHubIfConnected)
      .mockReset()
      .mockReturnValue({ request: hubRequest });
    listVoiceRecords.mockReset().mockImplementation(async () => []);
    deleteVoiceRecord.mockClear();
    connectionState.value = 'disconnected';
  });

  afterEach(() => {
    stopVoiceAudioOutboxFlush();
    vi.useRealTimers();
  });

  it('delivers a pending record transcript to the session draft and deletes the record', async () => {
    listVoiceRecords.mockResolvedValue([createEntry()]);
    await flushPendingVoiceAudio();

    expect(hubRequest).toHaveBeenCalledWith(
      'voice.transcribe',
      expect.objectContaining({ audioBase64: 'aGk=' }),
      expect.anything()
    );
    expect(hubRequest).toHaveBeenCalledWith('session.appendVoiceDraft', {
      sessionId: 's1',
      text: 'hello world',
      dedupId: 'rec-1',
    });
    expect(deleteVoiceRecord).toHaveBeenCalledWith('rec-1');
    expect(pendingVoiceAudioRecords.value).toEqual([]);
  });

  it('deletes the record without staging when transcription yields no speech', async () => {
    listVoiceRecords.mockResolvedValue([createEntry()]);
    hubRequest.mockResolvedValue({ text: '   ' });
    await flushPendingVoiceAudio();

    expect(deleteVoiceRecord).toHaveBeenCalledWith('rec-1');
    expect(hubRequest.mock.calls.some(([m]) => m === 'session.appendVoiceDraft')).toBe(false);
  });

  it('deletes the record when transcription is a deterministic refusal', async () => {
    listVoiceRecords.mockResolvedValue([createEntry()]);
    hubRequest.mockRejectedValue(new Error('Voice transcription requires audio/wav input'));
    await flushPendingVoiceAudio();

    expect(deleteVoiceRecord).toHaveBeenCalledWith('rec-1');
  });

  it('drops the record when the session no longer exists', async () => {
    listVoiceRecords.mockResolvedValue([createEntry()]);
    hubRequest.mockImplementation(async (method: string) => {
      if (method === 'session.appendVoiceDraft') throw new Error('Session not found');
      return { text: 'hello world' };
    });
    await flushPendingVoiceAudio();

    expect(deleteVoiceRecord).toHaveBeenCalledWith('rec-1');
  });

  it('keeps the record on a transient failure and retries on the follow-up schedule', async () => {
    vi.useFakeTimers();
    listVoiceRecords.mockResolvedValue([createEntry()]);
    hubRequest.mockRejectedValueOnce(
      new Error('Voice transcription rate limit exceeded; please wait before trying again')
    );
    await flushPendingVoiceAudio();

    expect(hubRequest).toHaveBeenCalledTimes(1);
    expect(deleteVoiceRecord).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(hubRequest).toHaveBeenCalledTimes(2);
    expect(deleteVoiceRecord).toHaveBeenCalledWith('rec-1');
  });

  it('skips silent and in-flight records without transcribing them', async () => {
    const silent = createEntry({ id: 'silent', peakLevel: 0.0004 });
    const busy = createEntry({ id: 'busy' });
    markVoiceAudioBusy('busy');
    listVoiceRecords.mockResolvedValue([silent, busy]);
    await flushPendingVoiceAudio();

    expect(hubRequest).not.toHaveBeenCalled();
    expect(deleteVoiceRecord).not.toHaveBeenCalled();
    expect(pendingVoiceAudioRecords.value).toHaveLength(2);
  });

  it('does nothing when the connection is down', async () => {
    listVoiceRecords.mockResolvedValue([createEntry()]);
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
    await flushPendingVoiceAudio();

    expect(hubRequest).not.toHaveBeenCalled();
    expect(deleteVoiceRecord).not.toHaveBeenCalled();
  });

  it('auto-flushes when the connection (re)establishes', async () => {
    vi.useFakeTimers();
    listVoiceRecords.mockResolvedValue([createEntry()]);
    startVoiceAudioOutboxFlush();
    connectionState.value = 'connected';
    await vi.advanceTimersByTimeAsync(600);

    expect(hubRequest).toHaveBeenCalled();
    expect(deleteVoiceRecord).toHaveBeenCalledWith('rec-1');
  });
});

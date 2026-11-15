// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hubRequest = vi.fn(async () => ({ text: 'hello world' }));

vi.mock('../../connection-manager', () => ({
  connectionManager: { getHubIfConnected: vi.fn(() => ({ request: hubRequest })) },
}));

const store = vi.hoisted(() => ({ records: [] }));

const recorder = vi.hoisted(() => ({
  isRecording: false,
  isStarting: false,
  durationLimitHit: false,
  sessionId: null as string | null,
  ownerId: null as string | null,
  stop: vi.fn(),
  cancel: vi.fn(async () => {}),
}));
vi.mock('../voice-recorder-store.ts', () => ({
  voiceRecorderStore: {
    isRecording: {
      get value() {
        return recorder.isRecording;
      },
    },
    isStarting: {
      get value() {
        return recorder.isStarting;
      },
    },
    durationLimitHit: {
      get value() {
        return recorder.durationLimitHit;
      },
    },
    recordingSessionId: {
      get value() {
        return recorder.sessionId;
      },
    },
    recordingOwnerId: {
      get value() {
        return recorder.ownerId;
      },
    },
    stop: recorder.stop,
    cancel: recorder.cancel,
  },
}));

vi.mock('../voice-audio-store.ts', () => ({
  listVoiceRecords: async () => store.records.map((r) => ({ ...r })),
  getVoiceRecord: async (id) => store.records.find((r) => r.id === id) ?? null,
  deleteVoiceRecord: async (id) => {
    store.records = store.records.filter((r) => r.id !== id);
    return true;
  },
  putVoiceRecord: async (entry) => {
    store.records.push({ ...entry });
    return true;
  },
}));

const enqueueTranscript = vi.hoisted(() => vi.fn(() => true));
const removePendingTranscript = vi.hoisted(() => vi.fn());
vi.mock('../voice-transcript-outbox.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  enqueueTranscript,
  removePendingTranscript,
}));

import { connectionManager } from '../../connection-manager.ts';
import { connectionState } from '../../state.ts';
import {
  beginInteractiveVoiceSubmit,
  endInteractiveVoiceSubmit,
  finalizeUnmountedRecording,
  flushPendingVoiceAudio,
  markVoiceAudioBusy,
  pendingVoiceAudioRecords,
  resetVoiceAudioOutbox,
  startVoiceAudioOutboxFlush,
  stopVoiceAudioOutboxFlush,
} from '../voice-audio-outbox.ts';

function seedEntry(overrides = {}) {
  const entry = {
    id: 'rec-1',
    sessionId: 's1',
    audioBase64: 'aGk=',
    mimeType: 'audio/wav',
    peakLevel: 0.5,
    createdAt: 1_726_000_000_000,
    ...overrides,
  };
  store.records.push(entry);
  return entry;
}

describe('voice audio outbox', () => {
  beforeEach(() => {
    resetVoiceAudioOutbox();
    store.records = [];
    recorder.isRecording = false;
    recorder.isStarting = false;
    recorder.durationLimitHit = false;
    recorder.sessionId = null;
    recorder.ownerId = null;
    recorder.stop.mockReset();
    recorder.cancel.mockClear();
    hubRequest.mockReset().mockImplementation(async () => ({ text: 'hello world' }));
    enqueueTranscript.mockReset().mockReturnValue(true);
    removePendingTranscript.mockClear();
    vi.mocked(connectionManager.getHubIfConnected)
      .mockReset()
      .mockReturnValue({ request: hubRequest });
    connectionState.value = 'disconnected';
  });

  afterEach(() => {
    stopVoiceAudioOutboxFlush();
    vi.useRealTimers();
  });

  it('delivers a pending record transcript to the session draft and deletes the record', async () => {
    seedEntry();
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
    expect(store.records).toEqual([]);
    expect(pendingVoiceAudioRecords.value).toEqual([]);
  });

  it('deletes the record without staging when transcription yields no speech', async () => {
    seedEntry();
    hubRequest.mockResolvedValue({ text: '   ' });
    await flushPendingVoiceAudio();

    expect(store.records).toEqual([]);
    expect(hubRequest.mock.calls.some(([m]) => m === 'session.appendVoiceDraft')).toBe(false);
  });

  it('deletes the record when transcription is a deterministic refusal', async () => {
    seedEntry();
    hubRequest.mockRejectedValue(new Error('Voice transcription requires audio/wav input'));
    await flushPendingVoiceAudio();

    expect(store.records).toEqual([]);
  });

  it('drops the record when the session no longer exists', async () => {
    seedEntry();
    hubRequest.mockImplementation(async (method: string) => {
      if (method === 'session.appendVoiceDraft') throw new Error('Session not found');
      return { text: 'hello world' };
    });
    await flushPendingVoiceAudio();

    expect(store.records).toEqual([]);
  });

  it('parks the transcript in the text outbox when draft staging is retryably refused', async () => {
    seedEntry();
    hubRequest.mockImplementation(async (method: string) => {
      if (method === 'session.appendVoiceDraft') {
        throw new Error('Pending voice draft is at the character limit');
      }
      return { text: 'hello world' };
    });
    enqueueTranscript.mockReturnValue(true);
    await flushPendingVoiceAudio();

    expect(enqueueTranscript).toHaveBeenCalledWith('s1', 'hello world', 'rec-1');
    expect(store.records).toEqual([]);
  });

  it('keeps the audio when the text outbox could not durably park the transcript', async () => {
    seedEntry();
    hubRequest.mockImplementation(async (method: string) => {
      if (method === 'session.appendVoiceDraft') {
        throw new Error('Pending voice draft is at the character limit');
      }
      return { text: 'hello world' };
    });
    enqueueTranscript.mockReturnValue(false);
    await flushPendingVoiceAudio();

    expect(enqueueTranscript).toHaveBeenCalledWith('s1', 'hello world', 'rec-1');
    expect(removePendingTranscript).toHaveBeenCalledWith('rec-1');
    expect(store.records).toHaveLength(1);
  });

  it('defers the flush while a recording is active', async () => {
    vi.useFakeTimers();
    seedEntry();
    recorder.isRecording = true;
    await flushPendingVoiceAudio();

    expect(hubRequest).not.toHaveBeenCalled();
    expect(store.records).toHaveLength(1);

    recorder.isRecording = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hubRequest).toHaveBeenCalled();
    expect(store.records).toEqual([]);
  });

  it('keeps the record when voice configuration refuses transcription', async () => {
    seedEntry();
    hubRequest.mockRejectedValue(new Error('Voice input is disabled'));
    await flushPendingVoiceAudio();

    expect(store.records).toHaveLength(1);
    expect(enqueueTranscript).not.toHaveBeenCalled();
  });

  it('defers the flush while an interactive submit is in flight', async () => {
    vi.useFakeTimers();
    seedEntry();
    beginInteractiveVoiceSubmit();
    await flushPendingVoiceAudio();

    expect(hubRequest).not.toHaveBeenCalled();
    expect(store.records).toHaveLength(1);

    endInteractiveVoiceSubmit();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hubRequest).toHaveBeenCalled();
    expect(store.records).toEqual([]);
  });

  it('rechecks claims before processing each snapshot entry', async () => {
    seedEntry({ id: 'first' });
    seedEntry({ id: 'second', sessionId: 's2' });
    hubRequest.mockImplementation(async () => {
      markVoiceAudioBusy('second');
      return { text: 'first done' };
    });
    await flushPendingVoiceAudio();

    expect(store.records.map((r) => r.id)).toEqual(['second']);
    expect(hubRequest).toHaveBeenCalledWith(
      'session.appendVoiceDraft',
      expect.objectContaining({ sessionId: 's1', dedupId: 'first' })
    );
  });

  it('keeps a silent record for manual resend without transcribing it', async () => {
    seedEntry({ peakLevel: 0.0004 });
    await flushPendingVoiceAudio();

    expect(hubRequest).not.toHaveBeenCalled();
    expect(store.records).toHaveLength(1);
    expect(pendingVoiceAudioRecords.value).toHaveLength(1);
  });

  it('defers newer records of a session after an older one fails retryably', async () => {
    vi.useFakeTimers();
    seedEntry({ id: 'older', audioBase64: 'b2xk' });
    seedEntry({ id: 'newer', sessionId: 's2', audioBase64: 'bmV3' });
    hubRequest.mockImplementation(async (_method: string, payload: { audioBase64: string }) => {
      if (payload.audioBase64 === 'b2xk') {
        throw new Error('Voice transcription rate limit exceeded; please wait before trying again');
      }
      return { text: 'from the newer record' };
    });
    const flushing = flushPendingVoiceAudio();
    await vi.advanceTimersByTimeAsync(140_000);
    await flushing;

    expect(store.records.map((r) => r.id)).toEqual(['older']);
    expect(hubRequest).toHaveBeenCalledWith(
      'session.appendVoiceDraft',
      expect.objectContaining({ sessionId: 's2', dedupId: 'newer' })
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(hubRequest.mock.calls.filter(([m]) => m === 'voice.transcribe').length).toBeGreaterThan(
      6
    );
    expect(store.records.map((r) => r.id)).toEqual(['older']);
  });

  it('keeps the record on a transient failure and retries on the follow-up schedule', async () => {
    vi.useFakeTimers();
    seedEntry();
    hubRequest.mockImplementation(async () => {
      throw new Error('Voice transcription rate limit exceeded; please wait before trying again');
    });
    const firstPass = flushPendingVoiceAudio();
    await vi.advanceTimersByTimeAsync(136_000);
    await firstPass;

    expect(hubRequest.mock.calls.filter(([m]) => m === 'voice.transcribe')).toHaveLength(6);
    expect(store.records).toHaveLength(1);

    hubRequest.mockImplementation(async () => ({ text: 'recovered' }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.records).toEqual([]);
    expect(hubRequest).toHaveBeenCalledWith(
      'session.appendVoiceDraft',
      expect.objectContaining({ sessionId: 's1', text: 'recovered', dedupId: 'rec-1' })
    );
  });

  it('skips records claimed by a manual resend without transcribing them', async () => {
    seedEntry({ id: 'claimed' });
    markVoiceAudioBusy('claimed');
    await flushPendingVoiceAudio();

    expect(hubRequest).not.toHaveBeenCalled();
    expect(store.records).toHaveLength(1);
  });

  it('does nothing when the connection is down', async () => {
    seedEntry();
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
    await flushPendingVoiceAudio();

    expect(hubRequest).not.toHaveBeenCalled();
    expect(store.records).toHaveLength(1);
  });

  it('auto-flushes when the connection (re)establishes', async () => {
    vi.useFakeTimers();
    seedEntry();
    startVoiceAudioOutboxFlush();
    connectionState.value = 'connected';
    await vi.advanceTimersByTimeAsync(600);

    expect(hubRequest).toHaveBeenCalled();
    expect(store.records).toEqual([]);
  });

  it('finalizes an unmounted recording into a pending draft record the flush delivers', async () => {
    recorder.isRecording = true;
    recorder.sessionId = 's1';
    recorder.stop.mockImplementation(async () => {
      recorder.isRecording = false;
      recorder.sessionId = null;
      return { audioBase64: 'bmV3', mimeType: 'audio/wav', peakLevel: 0.5 };
    });

    await finalizeUnmountedRecording('s1', 'owner-1');
    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(hubRequest).toHaveBeenCalledWith(
      'voice.transcribe',
      expect.objectContaining({ audioBase64: 'bmV3' }),
      expect.anything()
    );
    expect(hubRequest).toHaveBeenCalledWith('session.appendVoiceDraft', {
      sessionId: 's1',
      text: 'hello world',
      dedupId: expect.any(String),
    });
    expect(store.records).toEqual([]);
  });

  it('drops a silent recording instead of parking it in the retry tray', async () => {
    recorder.isRecording = true;
    recorder.sessionId = 's1';
    recorder.stop.mockImplementation(async () => {
      recorder.isRecording = false;
      recorder.sessionId = null;
      return { audioBase64: 'c2lsZW50', mimeType: 'audio/wav', peakLevel: 0.0004 };
    });

    await finalizeUnmountedRecording('s1', 'owner-1');
    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(store.records).toEqual([]);
  });

  it('refuses to finalize a recording another composer owns', async () => {
    recorder.isRecording = true;
    recorder.sessionId = 's1';
    recorder.ownerId = 'other-owner';

    await finalizeUnmountedRecording('s1', 'owner-1');
    expect(recorder.stop).not.toHaveBeenCalled();
    expect(store.records).toEqual([]);
  });

  it('refuses to finalize a recording belonging to another session', async () => {
    recorder.isRecording = true;
    recorder.sessionId = 's2';

    await finalizeUnmountedRecording('s1', 'owner-1');
    expect(recorder.stop).not.toHaveBeenCalled();
    expect(store.records).toEqual([]);
  });

  it('does nothing when no recording is active', async () => {
    await finalizeUnmountedRecording('s1', 'owner-1');
    expect(recorder.stop).not.toHaveBeenCalled();
    expect(store.records).toEqual([]);
  });
});

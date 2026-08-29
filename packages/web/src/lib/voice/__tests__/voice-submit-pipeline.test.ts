import { describe, expect, it } from 'vitest';
import type { VoiceRecordEntry } from '../voice-audio-store.ts';
import type { VoiceRecording } from '../voice-recorder-store.ts';
import {
  runVoiceSubmit,
  VOICE_SUBMIT_MAX_TRANSCRIBE_ATTEMPTS,
  type VoiceSubmitDeps,
} from '../voice-submit-pipeline.ts';

function createRecording(overrides: Partial<VoiceRecording> = {}): VoiceRecording {
  return { audioBase64: 'AAAA', mimeType: 'audio/wav', peakLevel: 0.5, ...overrides };
}

function createHarness(overrides: Partial<VoiceSubmitDeps> = {}) {
  const deleted: string[] = [];
  const delays: number[] = [];
  const persisted: VoiceRecordEntry[] = [];
  const deps: VoiceSubmitDeps = {
    stopRecording: async () => createRecording(),
    transcribe: async () => ({ text: ' hello world ' }),
    putRecord: async (entry) => {
      persisted.push(entry);
      return true;
    },
    deleteRecord: async (id) => {
      deleted.push(id);
      return true;
    },
    isMounted: () => true,
    currentSessionId: () => 'session-1',
    generateId: () => 'record-1',
    now: () => 1_725_000_000_000,
    delay: async (ms) => {
      delays.push(ms);
    },
    ...overrides,
  };
  return { deps, deleted, delays, persisted };
}

describe('runVoiceSubmit snapshot → stop → persist', () => {
  it('persists the stopped recording under the snapshotted id before transcribing', async () => {
    const order: string[] = [];
    const persistedEntries: VoiceRecordEntry[] = [];
    const harness = createHarness({
      stopRecording: async () => {
        order.push('stop');
        return createRecording({ audioBase64: 'BBB', hitDurationLimit: true, peakLevel: 0.9 });
      },
      putRecord: async (entry) => {
        order.push('persist');
        persistedEntries.push(entry);
        return true;
      },
      transcribe: async () => {
        order.push('transcribe');
        return { text: 'hi' };
      },
    });
    const result = await runVoiceSubmit({ sessionId: 'session-1', mode: 'send' }, harness.deps);
    expect(order).toEqual(['stop', 'persist', 'transcribe']);
    expect(persistedEntries).toEqual([
      {
        id: 'record-1',
        sessionId: 'session-1',
        audioBase64: 'BBB',
        mimeType: 'audio/wav',
        hitDurationLimit: true,
        peakLevel: 0.9,
        createdAt: 1_725_000_000_000,
      },
    ]);
    expect(result).toEqual({
      kind: 'routed',
      outcome: { kind: 'insert', transcript: 'hi', autoSend: true },
      recordId: 'record-1',
      persisted: true,
      dequeued: true,
      hitDurationLimit: true,
    });
  });

  it('halts silent recordings before persisting or transcribing them', async () => {
    const harness = createHarness({
      stopRecording: async () => createRecording({ peakLevel: 0.0005 }),
    });
    const result = await runVoiceSubmit({ sessionId: 'session-1' }, harness.deps);
    expect(result).toEqual({ kind: 'silent-recording', peakLevel: 0.0005 });
    expect(harness.persisted).toEqual([]);
    expect(harness.delays).toEqual([]);
    expect(harness.deleted).toEqual([]);
  });

  it('rejects and persists nothing when stopping the recorder fails', async () => {
    const harness = createHarness({
      stopRecording: async () => {
        throw new Error('Voice recorder is not recording');
      },
    });
    await expect(runVoiceSubmit({ sessionId: 'session-1' }, harness.deps)).rejects.toThrow(
      'Voice recorder is not recording'
    );
    expect(harness.persisted).toEqual([]);
    expect(harness.deleted).toEqual([]);
  });

  it('defaults store-facing deps to the real modules when only lifecycle deps are given', async () => {
    await expect(
      runVoiceSubmit(
        { sessionId: 'session-1' },
        { isMounted: () => true, currentSessionId: () => 'session-1' }
      )
    ).rejects.toThrow('Voice recorder is not recording');
  });

  it('continues with an unpersisted recording when the audio store is unavailable', async () => {
    const harness = createHarness({
      putRecord: async () => false,
    });
    const result = await runVoiceSubmit({ sessionId: 'session-1' }, harness.deps);
    expect(result).toMatchObject({ kind: 'routed', persisted: false, dequeued: true });
    expect(harness.deleted).toEqual(['record-1']);
  });
});

describe('runVoiceSubmit transcribe retry', () => {
  it('retries transient failures with policy delays and succeeds', async () => {
    let attempts = 0;
    const harness = createHarness({
      transcribe: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Request timeout: voice.transcribe (125000ms)');
        return { text: 'recovered' };
      },
    });
    const result = await runVoiceSubmit({ sessionId: 'session-1' }, harness.deps);
    expect(attempts).toBe(2);
    expect(harness.delays).toEqual([5_000]);
    expect(result).toMatchObject({
      kind: 'routed',
      outcome: { kind: 'insert', transcript: 'recovered', autoSend: false },
    });
  });

  it('fails immediately, deletes the record, and never retries on deterministic refusals', async () => {
    let attempts = 0;
    const harness = createHarness({
      transcribe: async () => {
        attempts += 1;
        throw new Error('Voice transcription requires audio/wav input');
      },
    });
    const result = await runVoiceSubmit({ sessionId: 'session-1' }, harness.deps);
    expect(attempts).toBe(1);
    expect(harness.delays).toEqual([]);
    expect(result).toMatchObject({
      kind: 'transcribe-failed',
      message: 'Voice transcription requires audio/wav input',
      attempts: 1,
      dequeued: true,
    });
    expect(harness.deleted).toEqual(['record-1']);
  });

  it('reports a kept record when deletion of a discarded record fails', async () => {
    const harness = createHarness({
      transcribe: async () => {
        throw new Error('Voice transcription failed with HTTP 413');
      },
      deleteRecord: async () => false,
    });
    const result = await runVoiceSubmit({ sessionId: 'session-1' }, harness.deps);
    expect(result).toMatchObject({
      kind: 'transcribe-failed',
      attempts: 1,
      dequeued: false,
      persisted: true,
    });
  });

  it('exhausts transient retries and keeps the persisted record for resend', async () => {
    let attempts = 0;
    const harness = createHarness({
      transcribe: async () => {
        attempts += 1;
        throw new Error('Voice transcription rate limit exceeded; please wait before trying again');
      },
    });
    const result = await runVoiceSubmit({ sessionId: 'session-1' }, harness.deps);
    expect(attempts).toBe(VOICE_SUBMIT_MAX_TRANSCRIBE_ATTEMPTS);
    expect(harness.delays).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(result).toMatchObject({
      kind: 'transcribe-failed',
      attempts: VOICE_SUBMIT_MAX_TRANSCRIBE_ATTEMPTS,
      recordId: 'record-1',
      persisted: true,
      dequeued: false,
    });
    expect(harness.deleted).toEqual([]);
  });

  it('trims blank transcripts to empty', async () => {
    const harness = createHarness({
      transcribe: async () => ({ text: '   ' }),
    });
    const result = await runVoiceSubmit({ sessionId: 'session-1' }, harness.deps);
    expect(result).toMatchObject({
      outcome: { kind: 'discard-with-reason', reason: 'No speech detected in that recording' },
      dequeued: true,
    });
  });
});

describe('runVoiceSubmit routing', () => {
  it('discards and dequeues when the recording target changed', async () => {
    const harness = createHarness({ currentSessionId: () => 'session-2' });
    const result = await runVoiceSubmit({ sessionId: 'session-1' }, harness.deps);
    expect(result).toMatchObject({
      outcome: {
        kind: 'discard-with-reason',
        reason: 'Recording target changed — transcript discarded',
      },
      dequeued: true,
    });
    expect(harness.deleted).toEqual(['record-1']);
  });

  it('returns deliver-unmounted without dequeue when the composer unmounted', async () => {
    const harness = createHarness({ isMounted: () => false });
    const result = await runVoiceSubmit({ sessionId: 'session-1', mode: 'queue' }, harness.deps);
    expect(result).toMatchObject({
      outcome: { kind: 'deliver-unmounted', transcript: 'hello world', mode: 'queue' },
      dequeued: false,
    });
    expect(harness.deleted).toEqual([]);
  });
});

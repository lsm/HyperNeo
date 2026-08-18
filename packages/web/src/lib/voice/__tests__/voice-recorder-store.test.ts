// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const gainNode = { connect: vi.fn(), disconnect: vi.fn() };
const analyserNode = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  fftSize: 0,
  smoothingTimeConstant: 0,
  getByteTimeDomainData: vi.fn((buf: Uint8Array) => {
    buf.fill(128);
  }),
};
const workletNode = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  port: { onmessage: null },
};
const mediaStreamSource = { connect: vi.fn(), disconnect: vi.fn() };
const fakeStream = {
  getTracks: vi.fn(() => [{ stop: vi.fn() }]),
};
const fakeContext = {
  state: 'running',
  sampleRate: 48_000,
  resume: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  createMediaStreamSource: vi.fn(() => mediaStreamSource),
  createAnalyser: vi.fn(() => analyserNode),
  createScriptProcessor: vi.fn(() => workletNode),
  audioWorklet: null,
  destination: {},
};

vi.stubGlobal(
  'AudioContext',
  vi.fn(function FakeAudioContextCtor() {
    return fakeContext;
  })
);
vi.stubGlobal('isSecureContext', true);
vi.stubGlobal('navigator', {
  mediaDevices: { getUserMedia: vi.fn(async () => fakeStream) },
});

import { VOICE_MAX_AUDIO_BYTES } from '@hyperneo/shared';
import { voiceRecorderStore, isVoiceRecordingSupported } from '../voice-recorder-store.ts';

import * as wav from '../../wav.ts';
vi.spyOn(wav, 'downsampleChunks');
vi.spyOn(wav, 'encodeWav');

describe('voiceRecorderStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeContext.state = 'running';
  });

  afterEach(async () => {
    await voiceRecorderStore.cancel();
  });

  it('exposes the idle state initially', () => {
    expect(voiceRecorderStore.isRecording.value).toBe(false);
    expect(voiceRecorderStore.isStarting.value).toBe(false);
    expect(voiceRecorderStore.durationLimitHit.value).toBe(false);
    expect(voiceRecorderStore.getLevel()).toBe(0);
  });

  it('reports secure-context support from the environment', () => {
    expect(isVoiceRecordingSupported()).toBe(true);
  });

  it('start() records the owning session and exposes it', async () => {
    await voiceRecorderStore.start('owner-a', 's1');
    expect(voiceRecorderStore.recordingSessionId.value).toBe('s1');
    await voiceRecorderStore.cancel();
    expect(voiceRecorderStore.recordingSessionId.value).toBeNull();
  });

  it('stamps the recording with its owning Space and clears it with ownership', async () => {
    await voiceRecorderStore.start('owner-a', 's1', null, 'space-9');
    expect(voiceRecorderStore.recordingSpaceId.value).toBe('space-9');
    voiceRecorderStore.orphan('owner-a');
    expect(voiceRecorderStore.recordingSpaceId.value).toBe('space-9');
    voiceRecorderStore.adopt('owner-b', 's1');
    expect(voiceRecorderStore.recordingSpaceId.value).toBe('space-9');
    const recording = await voiceRecorderStore.stop();
    expect(recording.audioBase64.length).toBeGreaterThan(0);
    expect(voiceRecorderStore.recordingSpaceId.value).toBeNull();
  });

  it('stamps a task-scoped recording with its task and clears it with ownership', async () => {
    await voiceRecorderStore.start('owner-a', 's1', null, 'space-9', 'task-42');
    expect(voiceRecorderStore.recordingTaskId.value).toBe('task-42');
    voiceRecorderStore.orphan('owner-a');
    voiceRecorderStore.adopt('owner-b', 's1');
    expect(voiceRecorderStore.recordingTaskId.value).toBe('task-42');
    const recording = await voiceRecorderStore.stop();
    expect(recording.audioBase64.length).toBeGreaterThan(0);
    expect(voiceRecorderStore.recordingTaskId.value).toBeNull();
  });

  it('a primary-chat recording carries no Space stamp', async () => {
    await voiceRecorderStore.start('owner-a', 's1');
    expect(voiceRecorderStore.recordingSpaceId.value).toBeNull();
    await voiceRecorderStore.cancel();
    expect(voiceRecorderStore.recordingSpaceId.value).toBeNull();
  });

  it('start() acquires the mic, wires the graph, and flips isRecording', async () => {
    await voiceRecorderStore.start('owner-a', 's1');

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(fakeContext.createMediaStreamSource).toHaveBeenCalledWith(fakeStream);
    expect(fakeContext.createAnalyser).toHaveBeenCalledTimes(1);
    expect(mediaStreamSource.connect).toHaveBeenCalledWith(analyserNode);
    expect(analyserNode.connect).toHaveBeenCalledWith(workletNode);
    expect(workletNode.connect).toHaveBeenCalledWith(fakeContext.destination);
    expect(voiceRecorderStore.isRecording.value).toBe(true);
  });

  it('start() while occupied rejects instead of clobbering the live owner', async () => {
    await voiceRecorderStore.start('owner-a', 's1');
    await expect(voiceRecorderStore.start('owner-b', 's2')).rejects.toThrow('busy');
    expect(voiceRecorderStore.recordingOwnerId.value).toBe('owner-a');
    expect(voiceRecorderStore.isRecording.value).toBe(true);
  });

  it('start() while limit-hit audio is buffered rejects (occupied, not idle)', async () => {
    await voiceRecorderStore.start('owner-a', 's1');
    const handler = workletNode.onaudioprocess;
    const samplesPerCallback = 4096;
    const capSamples = Math.floor((((VOICE_MAX_AUDIO_BYTES - 44) / 2) * 0.92 * 48_000) / 16_000);
    const needed = Math.ceil(capSamples / samplesPerCallback);
    for (let i = 0; i < needed + 1; i++) {
      handler({
        inputBuffer: { getChannelData: () => new Float32Array(samplesPerCallback).fill(0.5) },
      });
      if (voiceRecorderStore.durationLimitHit.value) break;
    }
    expect(voiceRecorderStore.durationLimitHit.value).toBe(true);
    expect(voiceRecorderStore.isRecording.value).toBe(false);
    await expect(voiceRecorderStore.start('owner-b', 's2')).rejects.toThrow('busy');
    const recording = await voiceRecorderStore.stop();
    expect(recording.audioBase64.length).toBeGreaterThan(0);
    expect(recording.hitDurationLimit).toBe(true);
  });

  it('stop() tears capture down and returns a WAV payload with a peak level', async () => {
    await voiceRecorderStore.start('owner-a', 's1');
    const handler = workletNode.onaudioprocess;
    expect(handler).toBeTruthy();
    handler({
      inputBuffer: { getChannelData: () => new Float32Array(48_000).fill(0.5) },
    });

    const recording = await voiceRecorderStore.stop();
    expect(voiceRecorderStore.recordingSessionId.value).toBeNull();

    expect(recording.mimeType).toBe('audio/wav');
    expect(typeof recording.audioBase64).toBe('string');
    expect(recording.audioBase64.length).toBeGreaterThan(0);
    expect(recording.hitDurationLimit).toBe(false);
    expect(recording.peakLevel).toBeGreaterThan(0.4);
    expect(mediaStreamSource.disconnect).toHaveBeenCalled();
    expect(fakeStream.getTracks).toHaveBeenCalled();
    expect(fakeContext.close).toHaveBeenCalled();
    expect(voiceRecorderStore.isRecording.value).toBe(false);
  });

  it('stop() without a recording rejects', async () => {
    await expect(voiceRecorderStore.stop()).rejects.toThrow('not recording');
  });

  it('cancel() discards an active recording without producing a payload', async () => {
    await voiceRecorderStore.start('owner-a', 's1');
    await voiceRecorderStore.cancel();

    expect(voiceRecorderStore.isRecording.value).toBe(false);
    await expect(voiceRecorderStore.stop()).rejects.toThrow('not recording');
    expect(mediaStreamSource.disconnect).toHaveBeenCalled();
  });

  it('orphan() keeps capture alive across a composer unmount, and adopt() restores ownership', async () => {
    await voiceRecorderStore.start('owner-a', 's1');
    voiceRecorderStore.orphan('owner-a');

    expect(voiceRecorderStore.isRecording.value).toBe(true);
    expect(mediaStreamSource.disconnect).not.toHaveBeenCalled();
    expect(fakeContext.close).not.toHaveBeenCalled();
    await expect(voiceRecorderStore.start('owner-b', 's2')).rejects.toThrow('busy');

    expect(voiceRecorderStore.adopt('owner-b', 's2')).toBe(false);
    expect(voiceRecorderStore.adopt('owner-b', 's1')).toBe(true);
    expect(voiceRecorderStore.recordingOwnerId.value).toBe('owner-b');
    const recording = await voiceRecorderStore.stop();
    expect(recording.audioBase64.length).toBeGreaterThan(0);
  });

  it('orphan() is scoped to the unmounting owner — another owner is untouched', async () => {
    await voiceRecorderStore.start('owner-a', 's1');
    voiceRecorderStore.orphan('owner-b');
    expect(voiceRecorderStore.recordingOwnerId.value).toBe('owner-a');
    expect(voiceRecorderStore.isRecording.value).toBe(true);
    voiceRecorderStore.orphan('owner-a');
    expect(voiceRecorderStore.recordingOwnerId.value).toBeNull();
    expect(voiceRecorderStore.isRecording.value).toBe(true);
  });

  it('orphan() preserves an in-flight start so it completes adoptably', async () => {
    let resolvePermission!: (value: unknown) => void;
    navigator.mediaDevices.getUserMedia.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePermission = resolve;
      })
    );
    const startPromise = voiceRecorderStore.start('owner-a', 's1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    voiceRecorderStore.orphan('owner-a');
    resolvePermission(fakeStream);
    await startPromise;
    expect(voiceRecorderStore.isRecording.value).toBe(true);
    expect(voiceRecorderStore.recordingOwnerId.value).toBeNull();
    expect(voiceRecorderStore.adopt('owner-b', 's1')).toBe(true);
    const recording = await voiceRecorderStore.stop();
    expect(recording.audioBase64.length).toBeGreaterThan(0);
  });

  it('buffers ownerless capped audio (adoptable) and evicts it only when the mic is needed', async () => {
    await voiceRecorderStore.start('owner-a', 's1');
    voiceRecorderStore.orphan('owner-a');
    const handler = workletNode.onaudioprocess;
    const capSamples = Math.floor((((VOICE_MAX_AUDIO_BYTES - 44) / 2) * 0.92 * 48_000) / 16_000);
    const needed = Math.ceil(capSamples / 4096);
    for (let i = 0; i < needed + 1; i++) {
      handler({
        inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.5) },
      });
    }
    expect(voiceRecorderStore.durationLimitHit.value).toBe(true);
    expect(voiceRecorderStore.isRecording.value).toBe(false);
    expect(voiceRecorderStore.adopt('owner-c', 's1')).toBe(true);
    const recording = await voiceRecorderStore.stop();
    expect(recording.audioBase64.length).toBeGreaterThan(0);
    expect(recording.hitDurationLimit).toBe(true);

    await voiceRecorderStore.start('owner-a', 's1');
    const handler2 = workletNode.onaudioprocess;
    for (let i = 0; i < needed + 1; i++) {
      handler2({
        inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.5) },
      });
    }
    voiceRecorderStore.orphan('owner-a');
    await voiceRecorderStore.start('owner-b', 's2');
    expect(voiceRecorderStore.recordingOwnerId.value).toBe('owner-b');
  });

  it('start() rejects as busy while an OWNED capped recording awaits its owner', async () => {
    await voiceRecorderStore.start('owner-a', 's1');
    const handler = workletNode.onaudioprocess;
    const capSamples = Math.floor((((VOICE_MAX_AUDIO_BYTES - 44) / 2) * 0.92 * 48_000) / 16_000);
    const needed = Math.ceil(capSamples / 4096);
    for (let i = 0; i < needed + 1; i++) {
      handler({
        inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.5) },
      });
    }
    await expect(voiceRecorderStore.start('owner-b', 's2')).rejects.toThrow('busy');
  });

  it('orphan() is a no-op when this store has no live recording', async () => {
    voiceRecorderStore.orphan('owner-a');
    expect(voiceRecorderStore.recordingOwnerId.value).toBeNull();
  });

  it('treats a pending getUserMedia as busy — a second composer cannot start', async () => {
    let resolvePermission!: (value: unknown) => void;
    navigator.mediaDevices.getUserMedia.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePermission = resolve;
      })
    );
    const first = voiceRecorderStore.start('owner-a', 's1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(voiceRecorderStore.start('owner-b', 's2')).rejects.toThrow('busy');
    expect(voiceRecorderStore.recordingOwnerId.value).toBe('owner-a');
    resolvePermission(fakeStream);
    await first;
    expect(voiceRecorderStore.isRecording.value).toBe(true);
  });

  it('survives a rejecting teardown: stop() still completes and clears ownership', async () => {
    await voiceRecorderStore.start('owner-a', 's1');
    fakeContext.close.mockRejectedValueOnce(new Error('InvalidStateError'));
    const recording = await voiceRecorderStore.stop();
    expect(recording.audioBase64.length).toBeGreaterThan(0);
    expect(voiceRecorderStore.recordingOwnerId.value).toBeNull();
    await voiceRecorderStore.start('owner-b', 's2');
    expect(voiceRecorderStore.recordingOwnerId.value).toBe('owner-b');
    expect(voiceRecorderStore.isRecording.value).toBe(true);
  });

  it('treats an in-flight stop teardown as busy — no ownerless takeover', async () => {
    await voiceRecorderStore.start('owner-a', 's1');
    let resolveClose!: () => void;
    fakeContext.close.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveClose = resolve;
      })
    );
    const stopPromise = voiceRecorderStore.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(voiceRecorderStore.start('owner-b', 's2')).rejects.toThrow('busy');
    resolveClose();
    await stopPromise;
    await voiceRecorderStore.start('owner-b', 's2');
    expect(voiceRecorderStore.recordingOwnerId.value).toBe('owner-b');
  });

  it('a stale capture callback after cancel cannot re-enter the limit state', async () => {
    await voiceRecorderStore.start('owner-a', 's1');
    const handler = workletNode.onaudioprocess;
    await voiceRecorderStore.cancel();
    expect(handler).toBeTruthy();
    handler({
      inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.5) },
    });
    expect(voiceRecorderStore.durationLimitHit.value).toBe(false);
    expect(voiceRecorderStore.isRecording.value).toBe(false);
    expect(voiceRecorderStore.recordingOwnerId.value).toBeNull();
    await voiceRecorderStore.start('owner-b', 's2');
    expect(voiceRecorderStore.recordingOwnerId.value).toBe('owner-b');
  });

  it('cancel() during a pending getUserMedia discards the stream without recording', async () => {
    let resolvePermission!: (value: unknown) => void;
    navigator.mediaDevices.getUserMedia.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePermission = resolve;
      })
    );
    const startPromise = voiceRecorderStore.start('owner-a', 's1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await voiceRecorderStore.cancel();
    const tracks = [{ stop: vi.fn() }];
    resolvePermission({ getTracks: () => tracks });

    await startPromise;
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(voiceRecorderStore.isRecording.value).toBe(false);
    expect(fakeContext.createMediaStreamSource).not.toHaveBeenCalled();
  });
});

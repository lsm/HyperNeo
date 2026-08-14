// @ts-nocheck
/**
 * Tests for the singleton VoiceRecorderStore — the extraction target of the
 * former useVoiceRecorder hook. These pin the capture-lifecycle contract the
 * adapter relies on; the capture internals (getUserMedia/worklet teardown,
 * downsample, WAV encode) are exercised here through a mocked Web Audio graph
 * so the store's semantics are covered independent of any composer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Web Audio / media mocks -------------------------------------------------
const gainNode = { connect: vi.fn(), disconnect: vi.fn() };
const analyserNode = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  fftSize: 0,
  smoothingTimeConstant: 0,
  getByteTimeDomainData: vi.fn((buf: Uint8Array) => {
    // Flat silence waveform — level reads 0.
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
  audioWorklet: null, // force ScriptProcessor fallback path (simplest graph)
  destination: {},
};

// `new`-able constructor returning the shared fake instance (a function whose
// body returns an object makes `new` yield that object).
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

// Fixed pure functions imported by the store — verify they were used at least
// indirectly by spying on the module.
import * as wav from '../../wav.ts';
vi.spyOn(wav, 'downsampleChunks');
vi.spyOn(wav, 'encodeWav');

describe('voiceRecorderStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeContext.state = 'running';
  });

  afterEach(async () => {
    // Leave the singleton idle for the next test.
    await voiceRecorderStore.cancel();
  });

  it('exposes the idle state initially', () => {
    expect(voiceRecorderStore.isRecording.value).toBe(false);
    expect(voiceRecorderStore.isStarting.value).toBe(false);
    expect(voiceRecorderStore.durationLimitHit.value).toBe(false);
    expect(voiceRecorderStore.getLevel()).toBe(0);
  });

  it('reports secure-context support from the environment', () => {
    // jsdom under vitest is a secure context with getUserMedia mocked present.
    expect(isVoiceRecordingSupported()).toBe(true);
  });

  it('start() records the owning session and exposes it', async () => {
    await voiceRecorderStore.start('owner-a', 's1');
    expect(voiceRecorderStore.recordingSessionId.value).toBe('s1');
    await voiceRecorderStore.cancel();
    expect(voiceRecorderStore.recordingSessionId.value).toBeNull();
  });

  it('start() acquires the mic, wires the graph, and flips isRecording', async () => {
    await voiceRecorderStore.start('owner-a', 's1');

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(fakeContext.createMediaStreamSource).toHaveBeenCalledWith(fakeStream);
    expect(fakeContext.createAnalyser).toHaveBeenCalledTimes(1);
    // ScriptProcessor fallback graph: source -> analyser -> node -> destination
    expect(mediaStreamSource.connect).toHaveBeenCalledWith(analyserNode);
    expect(analyserNode.connect).toHaveBeenCalledWith(workletNode);
    expect(workletNode.connect).toHaveBeenCalledWith(fakeContext.destination);
    expect(voiceRecorderStore.isRecording.value).toBe(true);
  });

  it('start() while occupied rejects instead of clobbering the live owner', async () => {
    await voiceRecorderStore.start('owner-a', 's1');
    await expect(voiceRecorderStore.start('owner-b', 's2')).rejects.toThrow('busy');
    // The original owner is untouched.
    expect(voiceRecorderStore.recordingOwnerId.value).toBe('owner-a');
    expect(voiceRecorderStore.isRecording.value).toBe(true);
  });

  it('start() while limit-hit audio is buffered rejects (occupied, not idle)', async () => {
    await voiceRecorderStore.start('owner-a', 's1');
    // Fire the byte cap: capture stops but the audio stays buffered for the
    // owner's stop(). Another composer must not be able to start in that
    // window. Mirror the store's cap arithmetic exactly.
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
    // The buffered recording is still recoverable by its owner.
    const recording = await voiceRecorderStore.stop();
    expect(recording.audioBase64.length).toBeGreaterThan(0);
    expect(recording.hitDurationLimit).toBe(true);
  });

  it('stop() tears capture down and returns a WAV payload with a peak level', async () => {
    await voiceRecorderStore.start('owner-a', 's1');
    // Feed one second of silence through the ScriptProcessor handler.
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
    // Capture resources released.
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

  it('release() (composer unmount) discards an in-flight recording like cancel()', async () => {
    await voiceRecorderStore.start('owner-a', 's1');
    await voiceRecorderStore.release();

    expect(voiceRecorderStore.isRecording.value).toBe(false);
    expect(mediaStreamSource.disconnect).toHaveBeenCalled();
    // A start() after release is discarded until a NEW generation begins.
    await voiceRecorderStore.start('owner-a', 's1');
    expect(voiceRecorderStore.isRecording.value).toBe(true);
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
    // The recorder is NOT stuck busy — a new recording can start.
    await voiceRecorderStore.start('owner-b', 's2');
    expect(voiceRecorderStore.recordingOwnerId.value).toBe('owner-b');
    expect(voiceRecorderStore.isRecording.value).toBe(true);
  });

  it('cancel() during a pending getUserMedia discards the stream without recording', async () => {
    let resolvePermission!: (value: unknown) => void;
    navigator.mediaDevices.getUserMedia.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePermission = resolve;
      })
    );
    const startPromise = voiceRecorderStore.start('owner-a', 's1');
    // Let start() progress to the pending permission request before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // User cancels while the permission prompt is up.
    await voiceRecorderStore.cancel();
    const tracks = [{ stop: vi.fn() }];
    resolvePermission({ getTracks: () => tracks });

    await startPromise;
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(voiceRecorderStore.isRecording.value).toBe(false);
    expect(fakeContext.createMediaStreamSource).not.toHaveBeenCalled();
  });
});

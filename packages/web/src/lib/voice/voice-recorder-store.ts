import { signal } from '@preact/signals';
import { VOICE_MAX_AUDIO_BYTES } from '@hyperneo/shared';
import { bytesToBase64, downsampleChunks, encodeWav } from '../wav.ts';

const TARGET_SAMPLE_RATE = 16_000;
const MAX_RECORDING_MS = 300_000;

type RecorderNode = AudioWorkletNode | ScriptProcessorNode;

export interface VoiceRecording {
  audioBase64: string;
  mimeType: 'audio/wav';
  hitDurationLimit?: boolean;
  peakLevel: number;
}

class VoiceRecorderStore {
  readonly isRecording = signal(false);
  readonly isStarting = signal(false);
  readonly durationLimitHit = signal(false);
  readonly recordingSessionId = signal<string | null>(null);
  readonly recordingSpaceId = signal<string | null>(null);
  readonly recordingTaskId = signal<string | null>(null);
  readonly recordingOwnerId = signal<string | null>(null);
  readonly recordingStartedAt = signal<number | null>(null);
  readonly recordingCursor = signal<{ start: number; end: number } | null>(null);

  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: RecorderNode | null = null;
  private analyser: AnalyserNode | null = null;
  private chunks: Float32Array[] = [];
  private sampleRate: number = TARGET_SAMPLE_RATE;
  private smoothedLevel = 0;
  private starting = false;
  private stopping = false;
  private stoppedByLimit = false;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private teardownPromise: Promise<void> | null = null;
  private startGeneration = 0;

  readonly start = async (
    ownerId: string,
    ownerSessionId: string,
    cursor?: { start: number; end: number } | null,
    ownerSpaceId?: string | null,
    ownerTaskId?: string | null
  ): Promise<void> => {
    if (this.isRecording.value || this.starting || this.stopping)
      throw new Error('Voice recorder is busy');
    if (this.stoppedByLimit && this.recordingOwnerId.value !== null) {
      throw new Error('Voice recorder is busy');
    }
    this.starting = true;
    this.isStarting.value = true;
    this.stoppedByLimit = false;
    this.durationLimitHit.value = false;
    this.recordingOwnerId.value = ownerId;
    this.recordingSessionId.value = ownerSessionId;
    this.recordingSpaceId.value = ownerSpaceId ?? null;
    this.recordingTaskId.value = ownerTaskId ?? null;
    this.recordingCursor.value = cursor ?? null;
    const generation = ++this.startGeneration;
    this.chunks = [];
    const discarded = () => this.startGeneration !== generation;
    const teardownDiscarded = async (
      context: AudioContext | null,
      stream: MediaStream | null,
      source: MediaStreamAudioSourceNode | null
    ) => {
      if (context && this.context === context) {
        await this.teardown();
        return;
      }
      try {
        source?.disconnect();
      } catch {}
      try {
        stream?.getTracks().forEach((track) => track.stop());
      } catch {}
      try {
        await context?.close();
      } catch {}
    };

    try {
      await this.teardown();
      if (discarded()) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: TARGET_SAMPLE_RATE,
        },
      });
      if (discarded()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;

      const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
      const context = new AudioContextCtor({ sampleRate: TARGET_SAMPLE_RATE });
      this.context = context;
      if (context.state === 'suspended') {
        await context.resume();
      }
      if (discarded()) {
        await teardownDiscarded(context, stream, null);
        return;
      }

      const source = context.createMediaStreamSource(stream);
      this.source = source;

      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      this.analyser = analyser;
      this.smoothedLevel = 0;

      const chunks: Float32Array[] = [];

      const maxDataSamples = Math.floor(((VOICE_MAX_AUDIO_BYTES - 44) / 2) * 0.92);
      const maxContextSamples = Math.floor(
        maxDataSamples * (context.sampleRate / TARGET_SAMPLE_RATE)
      );
      let totalSamples = 0;

      const hitLimit = () => {
        if (this.stoppedByLimit) return;
        this.stoppedByLimit = true;
        this.durationLimitHit.value = true;
        this.isRecording.value = false;
        void this.teardown();
      };

      let node: RecorderNode;
      try {
        if (!context.audioWorklet) throw new Error('AudioWorklet unavailable');
        const workletUrl = URL.createObjectURL(
          new Blob([audioWorkletSource()], { type: 'application/javascript' })
        );
        try {
          await context.audioWorklet.addModule(workletUrl);
        } finally {
          URL.revokeObjectURL(workletUrl);
        }
        if (discarded()) {
          await teardownDiscarded(context, stream, source);
          return;
        }
        node = new AudioWorkletNode(context, 'hyperneo-voice-recorder');
        node.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (this.stoppedByLimit) return;
          chunks.push(event.data);
          totalSamples += event.data.length;
          if (totalSamples >= maxContextSamples) hitLimit();
        };
      } catch {
        if (discarded()) {
          await teardownDiscarded(context, stream, source);
          return;
        }
        node = context.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (event) => {
          if (this.stoppedByLimit) return;
          const data = new Float32Array(event.inputBuffer.getChannelData(0));
          chunks.push(data);
          totalSamples += data.length;
          if (totalSamples >= maxContextSamples) hitLimit();
        };
      }
      this.node = node;

      source.connect(analyser);
      analyser.connect(node);
      node.connect(context.destination);

      this.chunks = chunks;
      this.sampleRate = context.sampleRate;
      this.maxDurationTimer = setTimeout(hitLimit, MAX_RECORDING_MS);
      this.recordingStartedAt.value = Date.now();
      this.isRecording.value = true;
    } catch (error) {
      if (this.startGeneration !== generation) return;
      await this.teardown();
      throw error;
    } finally {
      if (this.startGeneration === generation) {
        this.starting = false;
        this.isStarting.value = false;
      }
    }
  };

  readonly getLevel = (): number => {
    const analyser = this.analyser;
    if (!analyser) return 0;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    const target = Math.min(1, Math.sqrt(rms) * 2.2);
    this.smoothedLevel += (target - this.smoothedLevel) * 0.35;
    return this.smoothedLevel;
  };

  readonly stop = async (): Promise<VoiceRecording> => {
    if (!this.isRecording.value && !this.stoppedByLimit)
      throw new Error('Voice recorder is not recording');
    const hitDurationLimit = this.stoppedByLimit;
    this.durationLimitHit.value = false;
    this.isRecording.value = false;
    this.stopping = true;
    const chunks = this.chunks;
    try {
      await this.teardown();
      this.recordingOwnerId.value = null;
      this.recordingSessionId.value = null;
      this.recordingSpaceId.value = null;
      this.recordingTaskId.value = null;
      this.stoppedByLimit = false;
    } finally {
      this.stopping = false;
    }

    const totalSamples = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const mono = downsampleChunks(chunks, totalSamples, this.sampleRate, TARGET_SAMPLE_RATE);
    this.chunks = [];
    let peakLevel = 0;
    for (let i = 0; i < mono.length; i++) {
      const a = Math.abs(mono[i]);
      if (a > peakLevel) peakLevel = a;
    }
    const wav = encodeWav({ sampleRate: TARGET_SAMPLE_RATE, samples: mono });
    return { audioBase64: bytesToBase64(wav), mimeType: 'audio/wav', hitDurationLimit, peakLevel };
  };

  readonly cancel = async (): Promise<void> => {
    this.startGeneration += 1;
    this.starting = false;
    this.isStarting.value = false;
    this.chunks = [];
    this.stoppedByLimit = false;
    this.durationLimitHit.value = false;
    this.isRecording.value = false;
    this.recordingOwnerId.value = null;
    this.recordingSessionId.value = null;
    this.recordingSpaceId.value = null;
    this.recordingTaskId.value = null;
    this.recordingStartedAt.value = null;
    await this.teardown();
  };

  readonly orphan = (ownerId: string): void => {
    if (this.recordingOwnerId.value !== ownerId) return;
    this.recordingOwnerId.value = null;
  };

  readonly adopt = (ownerId: string, ownerSessionId: string): boolean => {
    if (this.recordingSessionId.value !== ownerSessionId) return false;
    if (this.recordingOwnerId.value !== null) return false;
    this.recordingOwnerId.value = ownerId;
    return true;
  };

  private readonly teardown = (): Promise<void> => {
    if (!this.teardownPromise) {
      const p = (async () => {
        try {
          if (this.maxDurationTimer) {
            clearTimeout(this.maxDurationTimer);
            this.maxDurationTimer = null;
          }
          if (this.node) {
            if ('port' in this.node) this.node.port.onmessage = null;
            else this.node.onaudioprocess = null;
          }
          this.source?.disconnect();
          this.node?.disconnect();
          this.stream?.getTracks().forEach((track) => track.stop());
          await this.context?.close();
        } catch {}
        this.source = null;
        this.node = null;
        this.analyser = null;
        this.stream = null;
        this.context = null;
      })();
      this.teardownPromise = p;
      void p.finally(() => {
        if (this.teardownPromise === p) this.teardownPromise = null;
      });
    }
    return this.teardownPromise;
  };
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

function audioWorkletSource(): string {
  return `
class HyperNeoVoiceRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) this.port.postMessage(new Float32Array(input[0]));
    return true;
  }
}
registerProcessor('hyperneo-voice-recorder', HyperNeoVoiceRecorder);
`;
}

export const voiceRecorderStore = new VoiceRecorderStore();

export function isVoiceRecordingSupported(): boolean {
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
}

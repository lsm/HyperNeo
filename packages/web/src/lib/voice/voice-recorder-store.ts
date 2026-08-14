/**
 * VoiceRecorderStore — singleton owner of the voice recording lifecycle.
 *
 * Extracted verbatim from useVoiceRecorder (PR: recorder → persistent store).
 * The hook is now a thin adapter; this module holds the capture state as
 * signals so any number of composers can observe the same recording, and a
 * later step can keep a recording alive across keyed-composer unmounts by
 * simply not calling release().
 *
 * All capture semantics (generation guard, shared idempotent teardown, byte
 * cap, 5-minute limit, ScriptProcessor fallback) are identical to the previous
 * hook implementation.
 */

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
  /** Peak absolute sample amplitude in [0, 1]; ~0 means the mic delivered silence. */
  peakLevel: number;
}

class VoiceRecorderStore {
  readonly isRecording = signal(false);
  readonly isStarting = signal(false);
  readonly durationLimitHit = signal(false);
  /**
   * The sessionId the current recording belongs to. Only the composer bound to
   * this session sees the recording; other concurrently-mounted composers
   * (e.g. an agent overlay over the base chat) observe an idle recorder, so
   * they can neither stop/transcribe someone else's recording nor release it
   * on their own unmount.
   */
  readonly recordingSessionId = signal<string | null>(null);
  /**
   * Unique token of the COMPOSER INSTANCE that owns the current recording.
   * Session IDs alone are insufficient: a Space task pane and an agent overlay
   * can both be mounted for the same session, so ownership is per mounted
   * composer (see useVoiceRecorder).
   */
  readonly recordingOwnerId = signal<string | null>(null);

  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: RecorderNode | null = null;
  private analyser: AnalyserNode | null = null;
  private chunks: Float32Array[] = [];
  private sampleRate: number = TARGET_SAMPLE_RATE;
  private smoothedLevel = 0;
  private starting = false;
  private stoppedByLimit = false;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  // In-flight teardown, shared so the limit path (fire-and-forget) and a
  // subsequent stop()/cancel() await the SAME promise instead of disconnecting
  // nodes and closing the AudioContext twice (the second close() rejects with
  // InvalidStateError and used to drop the whole recording into the error path).
  private teardownPromise: Promise<void> | null = null;
  // Monotonic generation for start(): cancel()/release() bumps it so an
  // in-flight getUserMedia / worklet setup can tell it has been discarded and
  // bail out instead of beginning a recording the user already cancelled.
  private startGeneration = 0;

  /**
   * Begin a recording owned by the composer instance `ownerId` (bound to
   * `ownerSessionId` for display/routing). The recorder is occupied while a
   * recording is active, starting, OR sitting on limit-hit audio awaiting its
   * owner's stop() — starting in that last window would destroy the buffered
   * recording.
   */
  readonly start = async (ownerId: string, ownerSessionId: string): Promise<void> => {
    if (this.isRecording.value || this.starting || this.stoppedByLimit)
      throw new Error('Voice recorder is busy');
    this.starting = true;
    this.isStarting.value = true;
    this.stoppedByLimit = false;
    this.durationLimitHit.value = false;
    this.recordingOwnerId.value = ownerId;
    this.recordingSessionId.value = ownerSessionId;
    const generation = ++this.startGeneration;
    const discarded = () => this.startGeneration !== generation;
    // Cleanup for a DISCARDED start. If the shared fields still belong to this
    // generation, defer to the shared (idempotent) teardown; if a NEWER
    // recording has already taken them over, clean up only this generation's
    // own resources so the live recording is never closed out from under the
    // user.
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
      } catch {
        /* already disconnected */
      }
      try {
        stream?.getTracks().forEach((track) => track.stop());
      } catch {
        /* already stopped */
      }
      try {
        await context?.close();
      } catch {
        /* already closed */
      }
    };

    try {
      // Wait out any in-flight teardown from a previous recording/cancel before
      // touching the shared fields — otherwise the old close()'s tail would
      // null the fields THIS start is about to populate.
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
      // The user cancelled (or the composer unmounted) while permission/setup
      // was pending — release the mic and do not begin recording.
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

      // Analyser taps the stream to drive the live level meter in VoiceWaveform.
      // It is a pass-through node, so the recorder worklet / script-processor
      // still receives the unmodified audio for capture.
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      this.analyser = analyser;
      this.smoothedLevel = 0;

      const chunks: Float32Array[] = [];

      // Cap accumulated samples so the recording stays under the daemon's byte
      // limit even if setTimeout is throttled in a background tab.
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
        // Worklet unavailable or blocked (e.g. desktop CSP disallowing blob:
        // scripts) — fall back to the deprecated ScriptProcessorNode capture.
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
      this.isRecording.value = true;
    } catch (error) {
      // A cancelled/discarded start fails silently — the user already moved on.
      if (this.startGeneration !== generation) return;
      await this.teardown();
      throw error;
    } finally {
      // Only the latest generation may clear startup state: after a cancel, a
      // stale in-flight start must not clobber a NEWER start()'s isStarting.
      if (this.startGeneration === generation) {
        this.starting = false;
        this.isStarting.value = false;
      }
    }
  };

  /** Current input level in [0, 1] for the VoiceWaveform meter. */
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
    // Compress (sqrt) + gain so even quiet conversational speech registers
    // clearly on the meter; clamp to [0, 1].
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
    this.recordingOwnerId.value = null;
    this.recordingSessionId.value = null;
    const chunks = this.chunks;
    await this.teardown();
    // Clear the guard only after capture callbacks are detached and chunks are
    // snapshotted, so queued onmessage/onaudioprocess callbacks don't resume
    // appending during teardown.
    this.stoppedByLimit = false;

    const totalSamples = chunks.reduce((total, chunk) => total + chunk.length, 0);
    // Downsample straight from the chunk list (no giant intermediate concat of
    // the full-rate capture — a 5-minute 48 kHz recording is ~55 MB of floats).
    const mono = downsampleChunks(chunks, totalSamples, this.sampleRate, TARGET_SAMPLE_RATE);
    this.chunks = [];
    // Peak scan so the caller can tell "mic captured silence" (muted/wrong
    // input device) apart from "the transcription backend returned no text" —
    // both otherwise surface as a confusing empty result.
    let peakLevel = 0;
    for (let i = 0; i < mono.length; i++) {
      const a = Math.abs(mono[i]);
      if (a > peakLevel) peakLevel = a;
    }
    const wav = encodeWav({ sampleRate: TARGET_SAMPLE_RATE, samples: mono });
    return { audioBase64: bytesToBase64(wav), mimeType: 'audio/wav', hitDurationLimit, peakLevel };
  };

  /** Discard the current recording (if any). Idempotent. */
  readonly cancel = async (): Promise<void> => {
    // Invalidate any in-flight start() so a pending getUserMedia cannot begin
    // a recording after the user explicitly discarded it — and clear the
    // visible startup state NOW, since that start() may be stuck awaiting the
    // browser permission prompt and cannot reach its own finally block.
    this.startGeneration += 1;
    this.starting = false;
    this.isStarting.value = false;
    this.chunks = [];
    this.stoppedByLimit = false;
    this.durationLimitHit.value = false;
    this.isRecording.value = false;
    this.recordingOwnerId.value = null;
    this.recordingSessionId.value = null;
    await this.teardown();
  };

  /**
   * Composer-unmount teardown: discards any in-flight or active recording.
   * Identical to the pre-store hook's unmount effect — the follow-up change
   * that keeps recordings alive across session switches removes this call from
   * the adapter without touching the capture logic.
   */
  readonly release = async (): Promise<void> => {
    this.startGeneration += 1;
    this.starting = false;
    this.isStarting.value = false;
    this.chunks = [];
    this.stoppedByLimit = false;
    this.durationLimitHit.value = false;
    this.isRecording.value = false;
    this.recordingOwnerId.value = null;
    this.recordingSessionId.value = null;
    await this.teardown();
  };

  private readonly teardown = (): Promise<void> => {
    if (!this.teardownPromise) {
      const p = (async () => {
        if (this.maxDurationTimer) {
          clearTimeout(this.maxDurationTimer);
          this.maxDurationTimer = null;
        }
        this.source?.disconnect();
        this.node?.disconnect();
        this.stream?.getTracks().forEach((track) => track.stop());
        await this.context?.close();
        this.source = null;
        this.node = null;
        this.analyser = null;
        this.stream = null;
        this.context = null;
        this.starting = false;
      })();
      this.teardownPromise = p;
      // Allow a future recording to tear down again once this one finished.
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

/** Process-wide singleton — the recording must outlive any single composer. */
export const voiceRecorderStore = new VoiceRecorderStore();

export function isVoiceRecordingSupported(): boolean {
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
}

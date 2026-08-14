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
   * The Space the recording was STARTED in (read from the starting composer's
   * surface), or null for a primary-chat recording. Survival and adoption are
   * session-scoped and never cross surfaces, so this stays valid for the
   * recording's whole life — the global chip uses it to route back through
   * the recording's OWNING surface instead of whichever Space happens to be
   * displayed when the user clicks Return.
   */
  readonly recordingSpaceId = signal<string | null>(null);
  /**
   * The Space TASK the recording was started for (from the starting composer's
   * surface), or null for ordinary chat recordings. A task-scoped recording's
   * transcript is delivered through `space.task.sendMessage` with task/agent/
   * node context — routing Return to a plain Space session chat would let the
   * adopting composer send it down ordinary session messaging instead. Kept
   * with the ownership claim so it survives adoption, and used by the chip to
   * reopen the task thread that speaks the originating messaging path.
   */
  readonly recordingTaskId = signal<string | null>(null);
  /**
   * Unique token of the COMPOSER INSTANCE that owns the current recording.
   * Session IDs alone are insufficient: a Space task pane and an agent overlay
   * can both be mounted for the same session, so ownership is per mounted
   * composer (see useVoiceRecorder).
   */
  readonly recordingOwnerId = signal<string | null>(null);
  /**
   * Wall-clock start time of the current recording, so an ADOPTING composer's
   * waveform can display the true remaining time against the unchanged cap
   * deadline instead of restarting its timer from the adoption mount.
   */
  readonly recordingStartedAt = signal<number | null>(null);
  /**
   * Composer-supplied insertion metadata for the current recording (caret /
   * selection endpoints in the owner's draft at recording start). The capture
   * layer is draft-agnostic; the owner sets this so an ADOPTING composer can
   * restore the original insertion point after a session-switch handoff.
   */
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
  // A stop() is between snapshotting its chunks and finishing teardown.
  // Another composer's start() in that window would be assigned ownership and
  // then have its IDs wiped when the stop's post-teardown cleanup runs.
  private stopping = false;
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
      // Capped audio still owned — its owner's stop() is pending.
      throw new Error('Voice recorder is busy');
    }
    // Claim ownership and the startup reservation BEFORE any await, so a
    // composer that unmounts or retargets mid-start is properly orphaned
    // (orphan() finds its ownerId here) and a concurrent start() stays busy
    // throughout.
    this.starting = true;
    this.isStarting.value = true;
    this.stoppedByLimit = false;
    this.durationLimitHit.value = false;
    this.recordingOwnerId.value = ownerId;
    this.recordingSessionId.value = ownerSessionId;
    this.recordingSpaceId.value = ownerSpaceId ?? null;
    this.recordingTaskId.value = ownerTaskId ?? null;
    // Insertion metadata supplied by the STARTING composer, stored with the
    // ownership claim (before any await) so it survives an unmount/adopt
    // handoff even if the composer departs mid-setup.
    this.recordingCursor.value = cursor ?? null;
    const generation = ++this.startGeneration;
    // Eviction of an orphaned capped buffer (if any): drop its audio up front.
    // The shared teardown inside the try below reclaims its mic graph.
    this.chunks = [];
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
      // Record the timestamp when capture is actually wired (beside the cap
      // deadline it mirrors), not at request time — a slow permission prompt
      // or worklet setup must not eat into the displayed 5-minute budget.
      this.recordingStartedAt.value = Date.now();
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
    this.stopping = true;
    const chunks = this.chunks;
    try {
      await this.teardown();
      // Ownership and the limit guard are cleared only AFTER teardown settles:
      // if teardown rejects, the original owner must still be able to cancel()
      // the recorder, and a busy store must never end up ownerless.
      this.recordingOwnerId.value = null;
      this.recordingSessionId.value = null;
      this.recordingSpaceId.value = null;
      this.recordingTaskId.value = null;
      // Clear the guard only after capture callbacks are detached and chunks
      // are snapshotted, so queued onmessage/onaudioprocess callbacks don't
      // resume appending during teardown.
      this.stoppedByLimit = false;
    } finally {
      // Even if the post-snapshot encoding throws, never wedge the recorder
      // busy — though note this finally covers the teardown+cleanup span; the
      // encoding below runs with the store already idle.
      this.stopping = false;
    }

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
    this.recordingSpaceId.value = null;
    this.recordingTaskId.value = null;
    this.recordingStartedAt.value = null;
    await this.teardown();
  };

  /**
   * Composer-unmount hand-off: the recording OUTLIVES its composer. If this
   * instance owned the recording, ONLY its ownership is cleared — capture
   * stays live (in-flight permission/setup included: the generation and
   * starting state are preserved so a pending start() completes adoptably),
   * and the composer that next mounts for the same session can adopt() it.
   * A composer that never owned the recording changes nothing. If nobody
   * returns, the 5-minute/byte cap eventually stops the mic and the audio
   * stays recoverable.
   */
  readonly orphan = (ownerId: string): void => {
    if (this.recordingOwnerId.value !== ownerId) return;
    this.recordingOwnerId.value = null;
  };

  /**
   * Claim an orphaned recording for a freshly-mounted composer. Succeeds only
   * when the recording belongs to `ownerSessionId` AND has no live owner — a
   * concurrently-mounted composer for the same session never steals ownership
   * from an active one. Returns whether this composer now owns the recording.
   */
  readonly adopt = (ownerId: string, ownerSessionId: string): boolean => {
    if (this.recordingSessionId.value !== ownerSessionId) return false;
    if (this.recordingOwnerId.value !== null) return false;
    this.recordingOwnerId.value = ownerId;
    return true;
  };

  /**
   * Shared, idempotent capture teardown. Never rejects (a failing close() must
   * not poison stop()/cancel()), and does NOT touch `starting`/`isStarting` —
   * a pending start() awaits this before acquiring the mic, and clearing the
   * starting guard here would make that in-flight setup look idle to another
   * composer. start()'s own finally (and cancel/release) own that flag.
   */
  private readonly teardown = (): Promise<void> => {
    if (!this.teardownPromise) {
      const p = (async () => {
        try {
          if (this.maxDurationTimer) {
            clearTimeout(this.maxDurationTimer);
            this.maxDurationTimer = null;
          }
          // Detach the capture handlers BEFORE disconnecting: an already-queued
          // worklet/ScriptProcessor callback that runs after stop()/cancel()/
          // release() cleared the limit guard would otherwise re-enter
          // hitLimit() and wedge the recorder busy (or tear down a newer
          // recording).
          if (this.node) {
            if ('port' in this.node) this.node.port.onmessage = null;
            else this.node.onaudioprocess = null;
          }
          this.source?.disconnect();
          this.node?.disconnect();
          this.stream?.getTracks().forEach((track) => track.stop());
          await this.context?.close();
        } catch {
          /* A rejecting close()/disconnect must not poison the recorder. */
        }
        this.source = null;
        this.node = null;
        this.analyser = null;
        this.stream = null;
        this.context = null;
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

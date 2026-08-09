import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { VOICE_MAX_AUDIO_BYTES } from '@hyperneo/shared';
import { bytesToBase64, downsampleChunks, encodeWav } from '../lib/wav.ts';

const TARGET_SAMPLE_RATE = 16_000;
const MAX_RECORDING_MS = 300_000;

type RecorderNode = AudioWorkletNode | ScriptProcessorNode;

export function isVoiceRecordingSupported(): boolean {
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
}

export interface VoiceRecording {
  audioBase64: string;
  mimeType: 'audio/wav';
  hitDurationLimit?: boolean;
  /** Peak absolute sample amplitude in [0, 1]; ~0 means the mic delivered silence. */
  peakLevel: number;
}

export function useVoiceRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [durationLimitHit, setDurationLimitHit] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nodeRef = useRef<RecorderNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef(TARGET_SAMPLE_RATE);
  const smoothedLevelRef = useRef(0);
  const startingRef = useRef(false);
  const stoppedByLimitRef = useRef(false);
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // Monotonic generation for start(): cancel() bumps it so an in-flight
  // getUserMedia / worklet setup can tell it has been discarded and bail out
  // instead of beginning a recording the user already cancelled.
  const startGenerationRef = useRef(0);
  // In-flight teardown, shared so the limit path (fire-and-forget) and a
  // subsequent stop()/cancel() await the SAME promise instead of disconnecting
  // nodes and closing the AudioContext twice (the second close() rejects with
  // InvalidStateError and used to drop the whole recording into the error path).
  const teardownRef = useRef<Promise<void> | null>(null);

  const teardown = useCallback((): Promise<void> => {
    if (!teardownRef.current) {
      const p = (async () => {
        if (maxDurationTimerRef.current) {
          clearTimeout(maxDurationTimerRef.current);
          maxDurationTimerRef.current = null;
        }
        sourceRef.current?.disconnect();
        nodeRef.current?.disconnect();
        streamRef.current?.getTracks().forEach((track) => track.stop());
        await contextRef.current?.close();
        sourceRef.current = null;
        nodeRef.current = null;
        analyserRef.current = null;
        streamRef.current = null;
        contextRef.current = null;
        startingRef.current = false;
      })();
      teardownRef.current = p;
      // Allow a future recording to tear down again once this one finished.
      void p.finally(() => {
        if (teardownRef.current === p) teardownRef.current = null;
      });
    }
    return teardownRef.current;
  }, []);

  const start = useCallback(async () => {
    if (isRecording || startingRef.current) return;
    startingRef.current = true;
    setIsStarting(true);
    stoppedByLimitRef.current = false;
    setDurationLimitHit(false);
    const generation = ++startGenerationRef.current;
    const discarded = () => !mountedRef.current || startGenerationRef.current !== generation;
    // Cleanup for a DISCARDED start. If the shared refs still belong to this
    // generation, defer to the shared (idempotent) teardown; if a NEWER recording
    // has already taken the refs over, clean up only this generation's own
    // resources so the live recording is never closed out from under the user.
    const teardownDiscarded = async (
      context: AudioContext | null,
      stream: MediaStream | null,
      source: MediaStreamAudioSourceNode | null
    ) => {
      if (context && contextRef.current === context) {
        await teardown();
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
      // touching the shared refs — otherwise the old close()'s tail would null
      // the refs THIS start is about to populate.
      await teardown();
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
      streamRef.current = stream;

      const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
      const context = new AudioContextCtor({ sampleRate: TARGET_SAMPLE_RATE });
      contextRef.current = context;
      if (context.state === 'suspended') {
        await context.resume();
      }
      if (discarded()) {
        await teardownDiscarded(context, stream, null);
        return;
      }

      const source = context.createMediaStreamSource(stream);
      sourceRef.current = source;

      // Analyser taps the stream to drive the live level meter in VoiceWaveform.
      // It is a pass-through node, so the recorder worklet / script-processor
      // still receives the unmodified audio for capture.
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      analyserRef.current = analyser;
      smoothedLevelRef.current = 0;

      const chunks: Float32Array[] = [];

      // Cap accumulated samples so the recording stays under the daemon's byte
      // limit even if setTimeout is throttled in a background tab.
      const maxDataSamples = Math.floor(((VOICE_MAX_AUDIO_BYTES - 44) / 2) * 0.92);
      const maxContextSamples = Math.floor(
        maxDataSamples * (context.sampleRate / TARGET_SAMPLE_RATE)
      );
      let totalSamples = 0;

      const hitLimit = () => {
        if (stoppedByLimitRef.current) return;
        stoppedByLimitRef.current = true;
        setDurationLimitHit(true);
        setIsRecording(false);
        void teardown();
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
          if (stoppedByLimitRef.current) return;
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
          if (stoppedByLimitRef.current) return;
          const data = new Float32Array(event.inputBuffer.getChannelData(0));
          chunks.push(data);
          totalSamples += data.length;
          if (totalSamples >= maxContextSamples) hitLimit();
        };
      }
      nodeRef.current = node;

      source.connect(analyser);
      analyser.connect(node);
      node.connect(context.destination);

      chunksRef.current = chunks;
      sampleRateRef.current = context.sampleRate;
      maxDurationTimerRef.current = setTimeout(hitLimit, MAX_RECORDING_MS);
      setIsRecording(true);
    } catch (error) {
      // A cancelled/discarded start fails silently — the user already moved on.
      if (startGenerationRef.current !== generation) return;
      await teardown();
      throw error;
    } finally {
      // Only the latest generation may clear startup state: after a cancel, a
      // stale in-flight start must not clobber a NEWER start()'s isStarting.
      if (startGenerationRef.current === generation) {
        startingRef.current = false;
        setIsStarting(false);
      }
    }
  }, [isRecording, teardown]);

  // Current input level in [0, 1] for the VoiceWaveform meter. Read via rAF by
  // the panel; never routed through Preact state (60fps updates).
  const getLevel = useCallback((): number => {
    const analyser = analyserRef.current;
    if (!analyser) return 0;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    // Compress (sqrt) + gain so even quiet conversational speech registers clearly
    // on the meter; clamp to [0, 1].
    const target = Math.min(1, Math.sqrt(rms) * 2.2);
    smoothedLevelRef.current += (target - smoothedLevelRef.current) * 0.35;
    return smoothedLevelRef.current;
  }, []);

  const stop = useCallback(async (): Promise<VoiceRecording> => {
    if (!isRecording && !stoppedByLimitRef.current)
      throw new Error('Voice recorder is not recording');
    const hitDurationLimit = stoppedByLimitRef.current;
    setDurationLimitHit(false);
    setIsRecording(false);
    const chunks = chunksRef.current;
    await teardown();
    // Clear the guard only after capture callbacks are detached and chunks are
    // snapshotted, so queued onmessage/onaudioprocess callbacks don't resume
    // appending during teardown.
    stoppedByLimitRef.current = false;

    const totalSamples = chunks.reduce((total, chunk) => total + chunk.length, 0);
    // Downsample straight from the chunk list (no giant intermediate concat of
    // the full-rate capture — a 5-minute 48 kHz recording is ~55 MB of floats).
    const mono = downsampleChunks(chunks, totalSamples, sampleRateRef.current, TARGET_SAMPLE_RATE);
    chunksRef.current = [];
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
  }, [isRecording, teardown]);

  const cancel = useCallback(async () => {
    // Invalidate any in-flight start() so a pending getUserMedia cannot begin a
    // recording after the user explicitly discarded it — and clear the visible
    // startup state NOW, since that start() may be stuck awaiting the browser
    // permission prompt and cannot reach its own finally block.
    startGenerationRef.current += 1;
    startingRef.current = false;
    setIsStarting(false);
    chunksRef.current = [];
    stoppedByLimitRef.current = false;
    setDurationLimitHit(false);
    setIsRecording(false);
    await teardown();
  }, [teardown]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      startGenerationRef.current += 1;
      void teardown();
    };
  }, [teardown]);

  return { isRecording, isStarting, durationLimitHit, start, stop, cancel, getLevel };
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

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

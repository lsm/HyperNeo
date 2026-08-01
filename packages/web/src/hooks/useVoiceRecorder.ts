import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { bytesToBase64, downsampleMono, encodeWav } from '../lib/wav.ts';

const TARGET_SAMPLE_RATE = 16_000;
const MAX_RECORDING_MS = 90_000;

type RecorderNode = AudioWorkletNode | ScriptProcessorNode;

export function isVoiceRecordingSupported(): boolean {
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
}

export interface VoiceRecording {
  audioBase64: string;
  mimeType: 'audio/wav';
  hitDurationLimit?: boolean;
}

export function useVoiceRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [durationLimitHit, setDurationLimitHit] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nodeRef = useRef<RecorderNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef(TARGET_SAMPLE_RATE);
  const startingRef = useRef(false);
  const stoppedByLimitRef = useRef(false);
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const cleanup = useCallback(async () => {
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
    streamRef.current = null;
    contextRef.current = null;
    startingRef.current = false;
  }, []);

  const stopCapture = useCallback(async () => {
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
    streamRef.current = null;
    contextRef.current = null;
  }, []);

  const start = useCallback(async () => {
    if (isRecording || startingRef.current) return;
    startingRef.current = true;
    setIsStarting(true);
    stoppedByLimitRef.current = false;
    setDurationLimitHit(false);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: TARGET_SAMPLE_RATE,
        },
      });
      if (!mountedRef.current) {
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

      const source = context.createMediaStreamSource(stream);
      sourceRef.current = source;
      const chunks: Float32Array[] = [];

      // Cap accumulated samples so the recording stays under the daemon's 3 MB
      // WAV limit even if setTimeout is throttled in a background tab.
      const maxDataSamples = Math.floor(((3 * 1024 * 1024 - 44) / 2) * 0.92);
      const maxContextSamples = Math.floor(
        maxDataSamples * (context.sampleRate / TARGET_SAMPLE_RATE)
      );
      let totalSamples = 0;

      const hitLimit = () => {
        if (stoppedByLimitRef.current) return;
        stoppedByLimitRef.current = true;
        setDurationLimitHit(true);
        setIsRecording(false);
        void stopCapture();
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

      source.connect(node);
      node.connect(context.destination);

      chunksRef.current = chunks;
      sampleRateRef.current = context.sampleRate;
      maxDurationTimerRef.current = setTimeout(hitLimit, MAX_RECORDING_MS);
      setIsRecording(true);
    } catch (error) {
      await cleanup();
      throw error;
    } finally {
      startingRef.current = false;
      setIsStarting(false);
    }
  }, [cleanup, isRecording, stopCapture]);

  const stop = useCallback(async (): Promise<VoiceRecording> => {
    if (!isRecording && !stoppedByLimitRef.current)
      throw new Error('Voice recorder is not recording');
    const hitDurationLimit = stoppedByLimitRef.current;
    setDurationLimitHit(false);
    setIsRecording(false);
    const chunks = chunksRef.current;
    await cleanup();
    // Clear the guard only after capture callbacks are detached and chunks are
    // snapshotted, so queued onmessage/onaudioprocess callbacks don't resume
    // appending during cleanup.
    stoppedByLimitRef.current = false;

    const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const samples = new Float32Array(sampleCount);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }

    const mono = downsampleMono(samples, sampleRateRef.current, TARGET_SAMPLE_RATE);
    const wav = encodeWav({ sampleRate: TARGET_SAMPLE_RATE, samples: mono });
    chunksRef.current = [];
    return { audioBase64: bytesToBase64(wav), mimeType: 'audio/wav', hitDurationLimit };
  }, [cleanup, isRecording]);

  const cancel = useCallback(async () => {
    chunksRef.current = [];
    stoppedByLimitRef.current = false;
    setDurationLimitHit(false);
    setIsRecording(false);
    await cleanup();
  }, [cleanup]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      void cleanup();
    };
  }, [cleanup]);

  return { isRecording, isStarting, durationLimitHit, start, stop, cancel };
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

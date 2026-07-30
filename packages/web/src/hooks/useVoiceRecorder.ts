import { useCallback, useRef, useState } from 'preact/hooks';
import { bytesToBase64, downsampleMono, encodeWav } from '../lib/wav.ts';

const TARGET_SAMPLE_RATE = 16_000;

type RecorderNode = AudioWorkletNode | ScriptProcessorNode;

export interface VoiceRecording {
  audioBase64: string;
  mimeType: 'audio/wav';
}

export function useVoiceRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nodeRef = useRef<RecorderNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef(TARGET_SAMPLE_RATE);

  const cleanup = useCallback(async () => {
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
    if (isRecording) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: TARGET_SAMPLE_RATE,
      },
    });
    const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
    const context = new AudioContextCtor({ sampleRate: TARGET_SAMPLE_RATE });
    const source = context.createMediaStreamSource(stream);
    const chunks: Float32Array[] = [];

    let node: RecorderNode;
    if (context.audioWorklet) {
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
        chunks.push(event.data);
      };
    } else {
      node = context.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (event) => {
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
    }

    source.connect(node);
    node.connect(context.destination);

    chunksRef.current = chunks;
    sampleRateRef.current = context.sampleRate;
    streamRef.current = stream;
    contextRef.current = context;
    sourceRef.current = source;
    nodeRef.current = node;
    setIsRecording(true);
  }, [isRecording]);

  const stop = useCallback(async (): Promise<VoiceRecording> => {
    if (!isRecording) throw new Error('Voice recorder is not recording');
    setIsRecording(false);
    const chunks = chunksRef.current;
    await cleanup();

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
    return { audioBase64: bytesToBase64(wav), mimeType: 'audio/wav' };
  }, [cleanup, isRecording]);

  const cancel = useCallback(async () => {
    chunksRef.current = [];
    setIsRecording(false);
    await cleanup();
  }, [cleanup]);

  return { isRecording, start, stop, cancel };
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

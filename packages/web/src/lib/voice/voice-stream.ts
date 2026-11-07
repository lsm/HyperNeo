import type { MessageHub } from '@hyperneo/shared';
import { bytesToBase64, downsampleChunks, encodePcm16 } from '../wav.ts';
import { getVoiceLanguage } from './voice-language.ts';
import { createVoiceOpusEncoder, type VoiceOpusEncoder } from './voice-opus-encoder.ts';

const STREAM_SAMPLE_RATE = 16_000;
const FLUSH_SAMPLES = 3_200;
const OPUS_PACKETS_PER_CHUNK = 10;
const MAX_PENDING_CHUNKS = 128;
export const VOICE_STREAM_STOP_TIMEOUT_MS = 125_000;

interface VoiceStreamTextEvent {
  streamId: string;
  text: string;
  isFinal: boolean;
}

type VoiceStreamFormat = 'opus' | 'pcm16' | 'batch';
interface VoiceStreamOptions {
  onFormat?: (format: VoiceStreamFormat) => void;
  onError?: (error: Error) => void;
}

function isPcmOnlyDaemon(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes('Voice streams take pcm16 audio at 16000 Hz')
  );
}

export interface VoiceLiveStream {
  push(samples: Float32Array, sampleRate: number): void;
  finish(): Promise<string | null>;
  close(): void;
}

export function openVoiceStream(
  hub: MessageHub,
  onText: (text: string) => void,
  options: VoiceStreamOptions = {}
): VoiceLiveStream {
  let streamId: string | null = null;
  let codec: VoiceOpusEncoder | null = null;
  let live = true;
  let closed = false;
  let stopped = false;
  let pending: Float32Array[] = [];
  let pendingSamples = 0;
  let opusPackets: Uint8Array[] = [];
  let queuedChunks = 0;
  let rate = STREAM_SAMPLE_RATE;
  let sending: Promise<void> = Promise.resolve();
  const unsubscribe = hub.onEvent<VoiceStreamTextEvent>('voice.stream.text', (event) => {
    if (!closed && streamId && event?.streamId === streamId) onText(event.text ?? '');
  });
  const fail = (cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (live && !closed) {
      options.onError?.(error);
      options.onFormat?.('batch');
    }
    live = false;
  };
  const send = (audio: Uint8Array) => {
    if (!streamId || !live) return;
    if (queuedChunks >= MAX_PENDING_CHUNKS) {
      fail(new Error('Voice upload queue is full'));
      return;
    }
    queuedChunks++;
    const id = streamId;
    const audioBase64 = bytesToBase64(audio);
    sending = sending
      .then(() => (live ? hub.request('voice.stream.chunk', { streamId: id, audioBase64 }) : null))
      .then(
        () => undefined,
        (error: unknown) => fail(error)
      )
      .finally(() => {
        queuedChunks--;
      });
  };
  const flushPackets = () => {
    if (!opusPackets.length) return;
    const bytes = new Uint8Array(opusPackets.reduce((sum, packet) => sum + packet.length, 0));
    let offset = 0;
    for (const packet of opusPackets) {
      bytes.set(packet, offset);
      offset += packet.length;
    }
    opusPackets = [];
    send(bytes);
  };
  const queuePacket = (packet: Uint8Array) => {
    opusPackets.push(packet);
    if (opusPackets.length >= OPUS_PACKETS_PER_CHUNK) flushPackets();
  };
  const flush = () => {
    if (!streamId || !live || !pendingSamples) return;
    const pcm = downsampleChunks(pending, pendingSamples, rate, STREAM_SAMPLE_RATE);
    pending = [];
    pendingSamples = 0;
    try {
      if (codec) codec.push(pcm);
      else send(encodePcm16(pcm));
    } catch (error) {
      fail(error);
    }
  };

  const language = getVoiceLanguage();
  const ready = (async () => {
    try {
      codec = await createVoiceOpusEncoder(queuePacket, fail);
      if (closed || !live) {
        codec?.close();
        return;
      }
      const start = (encoding: 'opus' | 'pcm16') =>
        hub.request<{ streamId: string; via: 'streaming' | 'batch'; formats?: string[] }>(
          'voice.stream.start',
          { encoding, sampleRate: STREAM_SAMPLE_RATE, ...(language === 'auto' ? {} : { language }) }
        );
      let started;
      try {
        started = await start(codec ? 'opus' : 'pcm16');
      } catch (error) {
        if (closed || !live) return;
        if (!codec || !isPcmOnlyDaemon(error)) throw error;
        codec.close();
        codec = null;
        started = await start('pcm16');
      }
      streamId = started.streamId;
      if (closed || !live) return;
      if (codec && !started.formats?.includes('opus')) {
        await hub.request('voice.stream.cancel', { streamId: started.streamId });
        streamId = null;
        codec.close();
        codec = null;
        if (closed || !live) return;
        started = await start('pcm16');
        streamId = started.streamId;
      }
      if (closed || !live) return;
      if (started.via !== 'streaming') {
        options.onFormat?.('batch');
        live = false;
        codec?.close();
        codec = null;
      } else {
        options.onFormat?.(codec ? 'opus' : 'pcm16');
        flush();
      }
    } catch (error) {
      fail(error);
    }
  })();

  let finished: Promise<void> | null = null;
  return {
    push(samples, sampleRate) {
      if (!live || closed) return;
      if (sampleRate < STREAM_SAMPLE_RATE) {
        fail(new Error('Voice capture sample rate is too low'));
        return;
      }
      rate = sampleRate;
      pending.push(samples);
      pendingSamples += samples.length;
      if (pendingSamples >= FLUSH_SAMPLES * (sampleRate / STREAM_SAMPLE_RATE)) flush();
    },
    async finish() {
      finished ??= ready.then(async () => {
        flush();
        if (codec && live) {
          try {
            await codec.finish();
            flushPackets();
          } catch (error) {
            fail(error);
          }
        }
        await sending;
      });
      await finished;
      if (!live || !streamId) return null;
      try {
        const result = await hub.request<{ text?: string }>(
          'voice.stream.stop',
          { streamId },
          { timeout: VOICE_STREAM_STOP_TIMEOUT_MS }
        );
        stopped = true;
        return result.text ?? '';
      } catch (error) {
        if (error instanceof Error && error.message.includes('Unknown voice stream')) {
          stopped = true;
          live = false;
          options.onError?.(error);
          return null;
        }
        throw error;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      void ready.then(() => {
        codec?.close();
        if (!streamId || stopped) return;
        stopped = true;
        live = false;
        return hub.request('voice.stream.cancel', { streamId }).catch(() => undefined);
      });
    },
  };
}

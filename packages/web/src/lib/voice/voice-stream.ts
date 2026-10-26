import type { MessageHub } from '@hyperneo/shared';
import { bytesToBase64, downsampleChunks, encodePcm16 } from '../wav.ts';
import { getVoiceLanguage } from './voice-language.ts';

const STREAM_SAMPLE_RATE = 16_000;
const FLUSH_SAMPLES = 3_200;
export const VOICE_STREAM_STOP_TIMEOUT_MS = 125_000;

interface VoiceStreamTextEvent {
  streamId: string;
  text: string;
  isFinal: boolean;
}

export interface VoiceLiveStream {
  push(samples: Float32Array, sampleRate: number): void;
  finish(): Promise<string | null>;
  close(): void;
}

export function openVoiceStream(hub: MessageHub, onText: (text: string) => void): VoiceLiveStream {
  let streamId: string | null = null;
  let live = true;
  let closed = false;
  let stopped = false;
  let pending: Float32Array[] = [];
  let pendingSamples = 0;
  let rate = STREAM_SAMPLE_RATE;
  let sending: Promise<void> = Promise.resolve();
  const unsubscribe = hub.onEvent<VoiceStreamTextEvent>('voice.stream.text', (event) => {
    if (!closed && streamId && event?.streamId === streamId) onText(event.text ?? '');
  });

  const flush = () => {
    if (!streamId || !live || !pendingSamples) return;
    const pcm = downsampleChunks(pending, pendingSamples, rate, STREAM_SAMPLE_RATE);
    pending = [];
    pendingSamples = 0;
    const audioBase64 = bytesToBase64(encodePcm16(pcm));
    const id = streamId;
    sending = sending
      .then(() => (live ? hub.request('voice.stream.chunk', { streamId: id, audioBase64 }) : null))
      .then(
        () => undefined,
        () => {
          live = false;
        }
      );
  };

  const language = getVoiceLanguage();
  const ready = hub
    .request<{ streamId: string; via: 'streaming' | 'batch' }>('voice.stream.start', {
      encoding: 'pcm16',
      sampleRate: STREAM_SAMPLE_RATE,
      ...(language === 'auto' ? {} : { language }),
    })
    .then(
      (started) => {
        if (started.via !== 'streaming') live = false;
        else streamId = started.streamId;
        flush();
      },
      () => {
        live = false;
      }
    );

  let finished: Promise<void> | null = null;
  return {
    push(samples, sampleRate) {
      if (!live || closed) return;
      if (sampleRate < STREAM_SAMPLE_RATE) {
        live = false;
        return;
      }
      rate = sampleRate;
      pending.push(samples);
      pendingSamples += samples.length;
      if (pendingSamples >= FLUSH_SAMPLES * (sampleRate / STREAM_SAMPLE_RATE)) flush();
    },
    async finish() {
      finished ??= ready.then(() => {
        flush();
        return sending;
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
        if (!streamId || stopped) return;
        stopped = true;
        live = false;
        return hub.request('voice.stream.cancel', { streamId }).catch(() => undefined);
      });
    },
  };
}

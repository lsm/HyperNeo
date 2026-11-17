import { Buffer } from 'node:buffer';
import type { VoiceStreamProtocol } from '@hyperneo/shared';

export interface AsrText {
  text: string;
  isFinal: boolean;
  end?: boolean;
}

export interface StreamProtocol {
  url: (endpoint: URL, sampleRate: number) => URL;
  authorization: (apiKey: string) => string;
  opening: () => string[];
  audio: (pcm: Uint8Array) => string | Uint8Array;
  finish: () => string;
  parse: (raw: string) => AsrText | null;
  needsEndMessage?: boolean;
}

const withDefaults = (endpoint: URL, params: Record<string, string>): URL => {
  const url = new URL(endpoint);
  for (const [name, value] of Object.entries(params))
    if (!url.searchParams.has(name)) url.searchParams.set(name, value);
  return url;
};

export const deepgram: StreamProtocol = {
  url: (endpoint, sampleRate) =>
    withDefaults(endpoint, {
      encoding: 'linear16',
      sample_rate: String(sampleRate),
      channels: '1',
      interim_results: 'true',
      endpointing: '700',
    }),
  authorization: (apiKey) => `Token ${apiKey}`,
  opening: () => [],
  audio: (pcm) => pcm,
  finish: () => JSON.stringify({ type: 'CloseStream' }),
  parse: (raw) => {
    try {
      const message = JSON.parse(raw) as {
        type?: unknown;
        is_final?: unknown;
        channel?: { alternatives?: { transcript?: unknown }[] };
      };
      const text = message.channel?.alternatives?.[0]?.transcript;
      return message.type === 'Results' && typeof text === 'string'
        ? { text: text.trim(), isFinal: message.is_final === true }
        : null;
    } catch {
      return null;
    }
  },
};

const resampler16To24k = () => {
  let carry: number | null = null;
  let at = 0;
  return (pcm: Uint8Array): Uint8Array => {
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength & ~1);
    const input = Array.from({ length: view.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true));
    const samples = carry === null ? input : [carry, ...input];
    if (!samples.length) return new Uint8Array(0);
    const out: number[] = [];
    for (; ; at += 2) {
      const j = Math.floor(at / 3);
      const f = at % 3;
      if (f ? j + 1 >= samples.length : j >= samples.length) break;
      out.push(f ? Math.round(samples[j] + ((samples[j + 1] - samples[j]) * f) / 3) : samples[j]);
    }
    at -= 3 * (samples.length - 1);
    carry = samples[samples.length - 1];
    const bytes = new DataView(new ArrayBuffer(out.length * 2));
    out.forEach((sample, i) => bytes.setInt16(i * 2, sample, true));
    return new Uint8Array(bytes.buffer);
  };
};

const openaiRealtime = (): StreamProtocol => {
  let partial = '';
  const resample = resampler16To24k();
  return {
    needsEndMessage: true,
    url: (endpoint) => withDefaults(endpoint, { intent: 'transcription' }),
    authorization: (apiKey) => `Bearer ${apiKey}`,
    opening: () => [
      JSON.stringify({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription: { model: 'gpt-4o-transcribe' },
              turn_detection: null,
            },
          },
        },
      }),
    ],
    audio: (pcm) =>
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: Buffer.from(resample(pcm)).toString('base64'),
      }),
    finish: () => JSON.stringify({ type: 'input_audio_buffer.commit' }),
    parse: (raw) => {
      try {
        const message = JSON.parse(raw) as {
          type?: unknown;
          delta?: unknown;
          transcript?: unknown;
        };
        if (message.type === 'error') return { text: partial, isFinal: false, end: false };
        if (message.type === 'conversation.item.input_audio_transcription.delta') {
          partial += typeof message.delta === 'string' ? message.delta : '';
          return { text: partial, isFinal: false };
        }
        if (message.type !== 'conversation.item.input_audio_transcription.completed') return null;
        partial = '';
        const text = typeof message.transcript === 'string' ? message.transcript.trim() : '';
        return { text, isFinal: true, end: true };
      } catch {
        return null;
      }
    },
  };
};

const protocols: Partial<Record<VoiceStreamProtocol, () => StreamProtocol>> = {
  deepgram: () => deepgram,
  'openai-realtime': openaiRealtime,
};

export function streamProtocol(name: VoiceStreamProtocol | undefined): StreamProtocol | null {
  return protocols[name ?? 'deepgram']?.() ?? null;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;

export function joinFinals(segments: readonly string[]): string {
  return segments.reduce((joined, next) => {
    if (!joined) return next;
    if (!next) return joined;
    return CJK.test(joined.at(-1) ?? '') || CJK.test(next[0]) ? joined + next : `${joined} ${next}`;
  }, '');
}

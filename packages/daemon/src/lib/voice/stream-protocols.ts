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

function pcm16To24k(pcm: Uint8Array): Uint8Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength & ~1);
  const samples = view.byteLength / 2;
  const out = new DataView(new ArrayBuffer(Math.floor((samples * 3) / 2) * 2));
  for (let i = 0; i < out.byteLength / 2; i++) {
    const at = (i * 2) / 3;
    const j = Math.floor(at);
    const a = view.getInt16(j * 2, true);
    const b = view.getInt16(Math.min(j + 1, samples - 1) * 2, true);
    out.setInt16(i * 2, Math.round(a + (b - a) * (at - j)), true);
  }
  return new Uint8Array(out.buffer);
}

const openaiRealtime = (): StreamProtocol => {
  let partial = '';
  return {
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
        audio: Buffer.from(pcm16To24k(pcm)).toString('base64'),
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

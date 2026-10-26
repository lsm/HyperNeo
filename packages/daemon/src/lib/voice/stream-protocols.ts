import type { VoiceStreamProtocol } from '@hyperneo/shared';

export const BATCH_TRANSCRIPTIONS_PATH = '/audio/transcriptions';

export function batchTranscriptionUrl(endpoint: URL): URL {
  if (endpoint.pathname.endsWith(BATCH_TRANSCRIPTIONS_PATH)) return endpoint;
  const derived = new URL(endpoint);
  derived.pathname = `${endpoint.pathname.replace(/\/+$/, '')}${BATCH_TRANSCRIPTIONS_PATH}`;
  return derived;
}

export interface AsrText {
  text: string;
  isFinal: boolean;
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

const protocols: Partial<Record<VoiceStreamProtocol, StreamProtocol>> = { deepgram };

export function streamProtocol(name: VoiceStreamProtocol | undefined): StreamProtocol | null {
  return protocols[name ?? 'deepgram'] ?? null;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;

export function joinFinals(segments: readonly string[]): string {
  return segments.reduce((joined, next) => {
    if (!joined) return next;
    if (!next) return joined;
    return CJK.test(joined.at(-1) ?? '') || CJK.test(next[0]) ? joined + next : `${joined} ${next}`;
  }, '');
}

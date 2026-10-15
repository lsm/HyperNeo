import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import { detectNeoReplyLanguage, type NeoReplyLanguage } from './reply-language.ts';

const LANGUAGE_NAMES: Readonly<Record<string, readonly string[]>> = {
  English: ['english', '英文', '英语', '英語', '영어'],
  Chinese: ['chinese', 'mandarin', '中文', '汉语', '漢語', '华语', '華語', '普通话', '중국어'],
  Japanese: ['japanese', '日本語', '日语', '日文', '일본어'],
  Korean: ['korean', '한국어', '韩语', '韓国語', '韩文', '한글'],
};

export function neoNamesLanguage(text: string, language: NeoReplyLanguage): boolean {
  const lower = text.toLowerCase();
  return (LANGUAGE_NAMES[language] ?? []).some((name) => lower.includes(name));
}

export interface NeoPublicationLanguageMismatch {
  expected: NeoReplyLanguage;
  published: NeoReplyLanguage;
  unrequested?: true;
}

const named = (language: NeoReplyLanguage | null): NeoReplyLanguage | null =>
  language && !language.startsWith('the language of') ? language : null;

export function planPublicationLanguage(
  input: Pick<NeoPublicationInput, 'shortText' | 'requestedLanguage'>,
  turnText: string | null
): NeoPublicationLanguageMismatch | null {
  const want = named(turnText === null ? null : detectNeoReplyLanguage(turnText));
  const got = named(detectNeoReplyLanguage(input.shortText));
  if (!want || !got || want === got) return null;
  if (!input.requestedLanguage) return { expected: want, published: got };
  return turnText !== null && neoNamesLanguage(turnText, got)
    ? null
    : { expected: want, published: got, unrequested: true };
}

export function requirePublicationLanguage(
  input: NeoPublicationInput,
  mismatch: NeoPublicationLanguageMismatch | null,
  fallback: boolean
):
  | { value: NeoPublicationInput }
  | { reason: { accepted: false; reason: 'wrong_language'; detail: string } } {
  return mismatch && !fallback
    ? {
        reason: {
          accepted: false,
          reason: 'wrong_language',
          detail: mismatch.unrequested
            ? `The human's message does not ask for a reply in ${mismatch.published}. Rewrite it in ${mismatch.expected}, this turn's reply language, and publish again.`
            : `This turn's reply language is ${mismatch.expected}, and this message reads as ${mismatch.published}. Rewrite it in ${mismatch.expected} and publish again; if the human asked for a reply in another language, publish again with requestedLanguage naming it.`,
        },
      }
    : { value: input };
}

export function flagPublicationLanguage(
  input: NeoPublicationInput,
  mismatch: NeoPublicationLanguageMismatch | null
): NeoPublicationInput {
  return mismatch ? { ...input, languageMismatch: mismatch.expected } : input;
}

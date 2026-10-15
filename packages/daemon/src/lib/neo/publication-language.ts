import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import { detectNeoReplyLanguage, type NeoReplyLanguage } from './reply-language.ts';

export interface NeoPublicationLanguageMismatch {
  expected: NeoReplyLanguage;
  published: NeoReplyLanguage;
}

const named = (language: NeoReplyLanguage | null): NeoReplyLanguage | null =>
  language && !language.startsWith('the language of') ? language : null;

export function planPublicationLanguage(
  input: Pick<NeoPublicationInput, 'shortText'>,
  expected: NeoReplyLanguage | null
): NeoPublicationLanguageMismatch | null {
  const want = named(expected);
  const got = named(detectNeoReplyLanguage(input.shortText));
  return want && got && want !== got ? { expected: want, published: got } : null;
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
          detail: `This turn's reply language is ${mismatch.expected}, and this message reads as ${mismatch.published}. Rewrite it in ${mismatch.expected} and publish again.`,
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

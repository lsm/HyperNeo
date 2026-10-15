import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { NeoAskOrigin } from './ask-origin.ts';

export type NeoReplyLanguage =
  | 'English'
  | 'Chinese'
  | 'Japanese'
  | 'Korean'
  | `the language of ${string}`;

const SAMPLE_LIMIT = 60;
const DETECT_LIMIT = 2000;

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

const ENGLISH_WORD =
  /\b(?:the|a|an|is|are|was|be|it|to|of|in|on|for|and|or|not|this|that|what|which|who|how|why|when|where|any|all|can|could|please|do|does|did|you|your|we|i|me|my|make|fix|show|check|there|still|now|with)\b/gi;

const ENGLISH_FRAME =
  /\b(?:the|this|that|these|those|what|which|how|why|does|is|are|mean|means|translate)\b/gi;

export function detectNeoReplyLanguage(text: string): NeoReplyLanguage | null {
  const prose = text
    .slice(0, DETECT_LIMIT)
    .replace(/```[\s\S]*?```|`[^`]*`/g, ' ')
    .split(/\s+/)
    .filter((token) => !/^[\x21-\x7e]+$/.test(token) || !/[/\\]|\.[A-Za-z]{1,5}\b|#\d/.test(token))
    .join(' ');
  const kana = count(prose, /[\u3040-\u30ff]/g);
  const hangul = count(prose, /[\uac00-\ud7af]/g);
  const cjk = kana + hangul + count(prose, /[\u4e00-\u9fff]/g);
  const words = count(prose, /[A-Za-z]{2,}/g);
  if (cjk >= 2 && cjk >= 2 * words) {
    if (count(prose, ENGLISH_FRAME)) return null;
    return kana >= 2 ? 'Japanese' : hangul >= 2 ? 'Korean' : 'Chinese';
  }
  if (cjk >= 2 && words < 2 * cjk) return null;
  const english = count(prose, ENGLISH_WORD);
  if (english >= 2 && english * 4 >= words) return 'English';
  const sample = prose.replace(/\s+/g, ' ').trim().slice(0, SAMPLE_LIMIT);
  return words >= 3 ? `the language of "${sample}"` : null;
}

export function neoPromptText(messages: readonly SDKMessage[]): string {
  return messages
    .flatMap((message) => {
      const content = (message as { message?: { content?: unknown } }).message?.content;
      if (typeof content === 'string') return [content];
      return Array.isArray(content)
        ? content.flatMap((block: { type?: unknown; text?: unknown }) =>
            block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
          )
        : [];
    })
    .join('\n');
}

export function isNeoReplyLanguageInput(internal: boolean, text: string | undefined): boolean {
  return !internal && !text?.trimStart().startsWith('/');
}

export function neoReplyLanguageNote(language: NeoReplyLanguage): string {
  return `Reply language for this turn: ${language}, the language of the human message it answers. Write everything for the human in ${language} unless that message asks for another language.`;
}

export function readNeoTurnLanguage(
  input: NeoAskOrigin,
  reads: {
    resolveAskOrigin(input: NeoAskOrigin): NeoAskOrigin | null;
    getPrompts(sessionId: string, messageId: string): SDKMessage[];
    latestHumanPrompt(sessionId: string): SDKMessage | null;
  }
): NeoReplyLanguage | null {
  const own = reads.getPrompts(input.sessionId, input.messageId);
  if (own.some((message) => (message as { inputKind?: unknown }).inputKind === 'human'))
    return detectNeoReplyLanguage(neoPromptText(own));
  const origin = reads.resolveAskOrigin(input);
  if (origin)
    return detectNeoReplyLanguage(
      neoPromptText(reads.getPrompts(origin.sessionId, origin.messageId))
    );
  const latest = reads.latestHumanPrompt(input.sessionId);
  return latest ? detectNeoReplyLanguage(neoPromptText([latest])) : null;
}

export function withNeoReplyLanguage<T extends { message?: { content?: unknown } }>(
  message: T,
  language: NeoReplyLanguage | null
): T {
  const content = message.message?.content;
  if (!language || content === undefined) return message;
  const note = neoReplyLanguageNote(language);
  return {
    ...message,
    message: {
      ...message.message,
      content: Array.isArray(content)
        ? [...content, { type: 'text', text: note }]
        : `${String(content)}\n\n${note}`,
    },
  };
}

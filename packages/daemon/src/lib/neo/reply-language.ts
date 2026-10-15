import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { NeoAskOrigin } from './ask-origin.ts';

export type NeoReplyLanguage = 'English' | 'Chinese' | 'Japanese' | 'Korean';

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

export function detectNeoReplyLanguage(text: string): NeoReplyLanguage | null {
  const prose = text.replace(/https?:\/\/\S+|`[^`]*`/g, ' ');
  const kana = count(prose, /[぀-ヿ]/g);
  const hangul = count(prose, /[가-힯]/g);
  const han = count(prose, /[一-鿿]/g);
  const words = count(prose, /[A-Za-z]{2,}/g);
  if (kana && kana + han >= words) return 'Japanese';
  if (hangul && hangul >= words) return 'Korean';
  if (han && han >= words) return 'Chinese';
  return words ? 'English' : null;
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

export function neoReplyLanguageNote(language: NeoReplyLanguage): string {
  return `Reply language for this turn: ${language}, the language of the human message it answers. Write everything for the human in ${language} unless that message asks for another language.`;
}

export function readNeoTurnLanguage(
  input: NeoAskOrigin,
  reads: {
    resolveAskOrigin(input: NeoAskOrigin): NeoAskOrigin | null;
    getPrompts(sessionId: string, messageId: string): SDKMessage[];
  }
): NeoReplyLanguage | null {
  const origin = reads.resolveAskOrigin(input);
  return origin
    ? detectNeoReplyLanguage(neoPromptText(reads.getPrompts(origin.sessionId, origin.messageId)))
    : null;
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

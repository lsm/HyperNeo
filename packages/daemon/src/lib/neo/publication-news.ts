import type { NeoAskOrigin } from './ask-origin.ts';

export const NEO_TURN_REPLY_LIMIT = 3;
const TURN_KEYS = 256;
const ACKNOWLEDGEMENTS = new Set([
  '收到',
  '我收到了',
  '收到了',
  '我听到了',
  '听到了',
  '好的',
  '好',
  '明白',
  '明白了',
  '了解',
  '知道了',
  'ok',
  'okay',
  'gotit',
  'noted',
  'onit',
  'roger',
  'sure',
  'willdo',
  'understood',
  'received',
  'iheardyou',
  'heard',
]);

type Draft = { publicationId: string; shortText: string; fullText: string };
type Rejection = { accepted: false; reason: string; detail: string };
export type NeoTurnReply = { publicationId: string; text: string };

export function neoReplyText(text: string): string {
  return text.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

export function neoTurnReplyKey(input: NeoAskOrigin, ask: NeoAskOrigin): string {
  return `${input.sessionId}|${input.messageId}|${ask.sessionId}|${ask.messageId}`;
}

export function requirePublicationNews<T>(
  value: T,
  draft: Draft,
  prior: readonly NeoTurnReply[]
): { value: T } | { reason: Rejection } {
  if (prior.some((reply) => reply.publicationId === draft.publicationId)) return { value };
  const text = neoReplyText(draft.shortText);
  if (ACKNOWLEDGEMENTS.has(text) && neoReplyText(draft.fullText) === text)
    return {
      reason: {
        accepted: false,
        reason: 'empty_acknowledgement',
        detail:
          'This only acknowledges the message. Publish when you have something to tell the human, or end the turn.',
      },
    };
  if (prior.some((reply) => reply.text === text))
    return {
      reason: {
        accepted: false,
        reason: 'repeated_reply',
        detail: 'You already published this reply to this ask in this turn; end the turn.',
      },
    };
  if (prior.length >= NEO_TURN_REPLY_LIMIT)
    return {
      reason: {
        accepted: false,
        reason: 'reply_limit',
        detail: `Already replied ${prior.length} times to this ask in this turn; end the turn.`,
      },
    };
  return { value };
}

export function recordNeoTurnReply(
  replies: Map<string, NeoTurnReply[]>,
  key: string,
  draft: Draft
): void {
  const prior = replies.get(key) ?? [];
  if (prior.some((reply) => reply.publicationId === draft.publicationId)) return;
  replies.delete(key);
  replies.set(key, [
    ...prior,
    { publicationId: draft.publicationId, text: neoReplyText(draft.shortText) },
  ]);
  for (const stale of replies.keys()) {
    if (replies.size <= TURN_KEYS) break;
    replies.delete(stale);
  }
}

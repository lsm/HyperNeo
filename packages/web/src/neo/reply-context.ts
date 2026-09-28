import type { ChatMessage } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

type Origin = { sessionId: string; messageId: string; replyId: string };
type Matched = Origin & { ask: ChatMessage };
type Reason = 'unknown_origin' | 'unavailable_ask' | 'direct_reply' | 'empty_ask';
type Gate<T> = { value: T } | { reason: Reason };
export type NeoReplyContext = { messageId: string; excerpt: string };

export function selectNeoReplyOrigin(message: ChatMessage, sessionId: string): Gate<Origin> {
  const origin = (message as { neoAskOrigin?: unknown }).neoAskOrigin;
  if (
    message.type !== 'assistant' ||
    message.parent_tool_use_id ||
    !message.uuid ||
    !sessionId.trim() ||
    !origin ||
    typeof origin !== 'object' ||
    Array.isArray(origin)
  )
    return { reason: 'unknown_origin' };
  const ref = origin as { sessionId?: unknown; messageId?: unknown };
  if (ref.sessionId !== sessionId || typeof ref.messageId !== 'string' || !ref.messageId.trim())
    return { reason: 'unknown_origin' };
  return { value: { sessionId, messageId: ref.messageId, replyId: message.uuid } };
}

function humanAsk(message: ChatMessage): boolean {
  return (
    message.type === 'user' &&
    !message.parent_tool_use_id &&
    (message as { inputKind?: string }).inputKind !== 'system'
  );
}

export function matchNeoReplyInput(
  origin: Origin,
  messages: readonly ChatMessage[]
): Gate<Matched> {
  const asks = messages.filter((m) => m.uuid === origin.messageId);
  const replies = messages.filter((m) => m.uuid === origin.replyId);
  const ask = asks[0];
  if (
    asks.length !== 1 ||
    replies.length !== 1 ||
    !humanAsk(ask) ||
    replies[0].type !== 'assistant' ||
    replies[0].parent_tool_use_id
  )
    return { reason: 'unavailable_ask' };
  const askSession = (ask as { session_id?: string }).session_id;
  const replyIndex = messages.indexOf(replies[0]);
  if ((askSession && askSession !== origin.sessionId) || messages.indexOf(ask) >= replyIndex)
    return { reason: 'unavailable_ask' };
  return messages.slice(0, replyIndex).filter(humanAsk).at(-1)?.uuid === origin.messageId
    ? { reason: 'direct_reply' }
    : { value: { ...origin, ask } };
}

export function presentNeoReplyContext(
  matched: Matched,
  readText: (message: ChatMessage) => string
): Gate<NeoReplyContext> {
  const text = readText(matched.ask).replace(/\s+/g, ' ').trim();
  if (!text) return { reason: 'empty_ask' };
  const excerpt = text.length > 120 ? `${text.slice(0, 119)}…` : text;
  return { value: { messageId: matched.messageId, excerpt } };
}

export const projectNeoReplyContext = (superpipe({})('neo-reply-context') as PipelineAPI)
  .input(['message', 'sessionId', 'messages', 'readText'])
  .pipe(selectNeoReplyOrigin, ['message', 'sessionId'], 'result:context')
  .pipe(matchNeoReplyInput, ['context', 'messages'], 'result:context')
  .pipe(presentNeoReplyContext, ['context', 'readText'], 'result:context')
  .end('context') as (
  message: ChatMessage,
  sessionId: string,
  messages: readonly ChatMessage[],
  readText: (message: ChatMessage) => string
) => NeoReplyContext | Reason;

export function neoMessageAnchor(sessionId: string, messageId: string): string {
  return `neo-message-${encodeURIComponent(sessionId)}-${encodeURIComponent(messageId)}`;
}

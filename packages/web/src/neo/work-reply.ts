import type { ChatMessage } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import superpipe, { type PipelineAPI } from 'superpipe';

type Input = { messageId: string; replyId: string };
type Reply = { replyId: string; work: NeoWork };
type Reason = 'legacy' | 'unknown_origin' | 'no_report';
type Gate<T> = { value: T } | { reason: Reason };

export function selectNeoWorkReplyInput(message: ChatMessage, sessionId: string): Gate<Input> {
  if (message.type !== 'assistant' || !Object.hasOwn(message, 'neoInputOrigin'))
    return { reason: 'legacy' };
  const origin = (message as { neoInputOrigin?: unknown }).neoInputOrigin;
  if (
    !message.uuid ||
    message.parent_tool_use_id ||
    !sessionId.trim() ||
    !origin ||
    typeof origin !== 'object' ||
    Array.isArray(origin)
  )
    return { reason: 'unknown_origin' };
  const ref = origin as { sessionId?: unknown; messageId?: unknown };
  if (ref.sessionId !== sessionId || typeof ref.messageId !== 'string' || !ref.messageId.trim())
    return { reason: 'unknown_origin' };
  return { value: { messageId: ref.messageId, replyId: message.uuid } };
}

export function matchNeoWorkReplyReceipt(
  input: Input,
  receipts: ReadonlyMap<string, NeoWork>
): Gate<Reply> {
  const work = receipts.get(input.messageId);
  if (!work?.report || !['reported', 'failed'].includes(work.status))
    return { reason: 'no_report' };
  if (
    input.messageId !== work.id &&
    input.messageId !== `neo-consult:neo-work:${work.id}:review:reply`
  )
    return { reason: 'no_report' };
  return { value: { replyId: input.replyId, work } };
}

export const projectNeoWorkReply = (superpipe({})('neo-work-reply') as PipelineAPI)
  .input(['message', 'sessionId', 'receipts'])
  .pipe(selectNeoWorkReplyInput, ['message', 'sessionId'], 'result:reply')
  .pipe(matchNeoWorkReplyReceipt, ['reply', 'receipts'], 'result:reply')
  .end('reply') as (
  message: ChatMessage,
  sessionId: string,
  receipts: ReadonlyMap<string, NeoWork>
) => Reply | Reason;

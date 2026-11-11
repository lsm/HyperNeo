import { z } from 'zod';
import { NeoSessionMessageRepository } from '../../storage/repositories/neo-session-message-repository.ts';
import { NeoPublicationDraft } from './publication-operation.ts';
import { frontSessionId } from './front-mode.ts';
import type { NeoService } from './service.ts';

const ReadyReply = z.strictObject({
  publication: z
    .object({
      ...NeoPublicationDraft.shape,
      requestId: z.string().optional(),
      replyTo: z.array(z.uuid()).min(1).max(100),
    })
    .strict(),
});

export async function forwardFrontPublication(
  service: NeoService,
  conversationId: string,
  messageId: string
) {
  const sessionId = frontSessionId(conversationId);
  const message = new NeoSessionMessageRepository(service.db.getDatabase()).get(
    conversationId,
    messageId
  );
  if (
    !message ||
    message.fromSession !== service.defaultSessionId() ||
    message.toSession !== sessionId
  )
    return { accepted: false, reason: 'unknown_back_reply' };
  let body: unknown;
  try {
    body = JSON.parse(message.text);
  } catch {
    return { accepted: false, reason: 'not_a_ready_reply' };
  }
  const ready = ReadyReply.safeParse(body);
  if (!ready.success) return { accepted: false, reason: 'not_a_ready_reply' };
  if (!ready.data.publication.replyTo.every((id) => service.asks.find(conversationId, id)))
    return { accepted: false, reason: 'unknown_reply_target' };
  return service.publish(
    { ...ready.data.publication, requestId: `front-forward:${messageId}` },
    { source: 'mcp', sessionId }
  );
}

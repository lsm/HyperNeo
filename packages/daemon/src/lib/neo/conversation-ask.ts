import type { NeoConversationAskInput } from '@hyperneo/shared/types/neo-conversation-ask';
import { z } from 'zod';
import { toMailboxMessage } from '../mailbox/entry.ts';
import { SendMessageInputSchema } from '../messaging/message-send.ts';

export const NeoConversationAskSchema = z
  .object({
    conversationId: z.uuid(),
    requestId: z.uuid(),
    askOrigin: z
      .object({
        sessionId: z
          .string()
          .min(1)
          .max(160)
          .refine((id) => !!id.trim()),
        messageId: z.uuid(),
      })
      .strict(),
    content: SendMessageInputSchema.shape.message.shape.message.shape.content,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.requestId !== input.askOrigin.messageId)
      context.addIssue({ code: 'custom', message: 'Request and original ask identity differ.' });
    const projected = toMailboxMessage({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: input.content },
    });
    if ('reason' in projected) context.addIssue({ code: 'custom', message: projected.reason });
  })
  .transform((input) => ({
    ...input,
    content:
      typeof input.content === 'string'
        ? [{ type: 'text' as const, text: input.content }]
        : input.content,
  }));

export function admitNeoConversationAsk(
  input: unknown
): { value: NeoConversationAskInput } | { reason: 'invalid_ask' } {
  const parsed = NeoConversationAskSchema.safeParse(input);
  return parsed.success ? { value: parsed.data } : { reason: 'invalid_ask' };
}

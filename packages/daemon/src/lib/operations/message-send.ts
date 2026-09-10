import { generateUUID } from '@hyperneo/shared';
import { z } from 'zod';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { renderAddress } from '../mailbox/address.ts';
import { toMailboxMessage, type MailboxMessage } from '../mailbox/entry.ts';
import { handoffPromptToMailbox } from '../mailbox/handoff.ts';
import { defineOperation } from './registry.ts';

export const SendMessageInputSchema = z.object({
  sessionId: z.string().min(1),
  message: z
    .unknown()
    .transform((value, ctx) => {
      const projected = toMailboxMessage(value as MailboxMessage);
      if ('reason' in projected) {
        ctx.addIssue({ code: 'custom', message: projected.reason });
        return z.NEVER;
      }
      return projected.message;
    })
    .describe(
      'User message with text or image content; optional priority, inputKind and referenceMetadata.'
    ),
  deliveryMode: z.enum(['immediate', 'defer']).optional(),
});

export const SendMessageResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted'), mailboxId: z.string(), messageId: z.string() }),
  z.object({ kind: z.literal('rejected'), reason: z.string() }),
]);

export function createSendMessageOperation(jobQueue: JobQueueRepository) {
  return defineOperation({
    name: 'message.send',
    description:
      'Persist a message for a session in this daemon. Acceptance does not mean the session has processed it or replied.',
    inputSchema: SendMessageInputSchema,
    resultSchema: SendMessageResultSchema,
    execute: async (input, caller) => {
      const messageId = generateUUID();
      const outcome = await handoffPromptToMailbox({
        to: renderAddress({ kind: 'session', sessionId: input.sessionId }),
        message: input.message,
        origin: caller.sessionId
          ? renderAddress({ kind: 'session', sessionId: caller.sessionId })
          : caller.source === 'rpc'
            ? 'chat'
            : 'system',
        messageUuid: messageId,
        deliveryMode: input.deliveryMode,
        jobQueue,
      });
      return outcome.kind === 'enqueued'
        ? { kind: 'accepted' as const, mailboxId: outcome.id, messageId }
        : { kind: 'rejected' as const, reason: outcome.reason };
    },
  });
}

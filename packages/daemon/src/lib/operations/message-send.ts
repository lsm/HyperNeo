import { generateUUID } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { isValidAddress, renderAddress } from '../mailbox/address.ts';
import { toMailboxMessage } from '../mailbox/entry.ts';
import { handoffPromptToMailbox, type MailboxHandoffOutcome } from '../mailbox/handoff.ts';
import { defineOperation, type OperationCaller } from './registry.ts';

const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1) }),
  z.object({
    type: z.literal('image'),
    source: z.object({
      type: z.literal('base64'),
      media_type: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
      data: z.string().min(1),
    }),
  }),
]);

export const SendMessageInputSchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .refine(
      (sessionId) => isValidAddress({ kind: 'session', sessionId }),
      'Session ID must be URI-encodable'
    ),
  message: z
    .object({
      type: z.literal('user'),
      message: z.object({
        role: z.literal('user').optional(),
        content: z.union([z.string().min(1), z.array(ContentBlockSchema).min(1)]),
      }),
      parent_tool_use_id: z.null(),
      priority: z.enum(['now', 'next', 'later']).optional(),
      inputKind: z.enum(['task', 'human', 'system']).optional(),
      referenceMetadata: z
        .record(
          z.string(),
          z.object({
            type: z.enum(['task', 'goal', 'file', 'folder']),
            id: z.string().min(1),
            displayText: z.string().min(1),
            status: z.string().optional(),
          })
        )
        .optional(),
    })
    .superRefine((message, ctx) => {
      const projected = toMailboxMessage(message);
      if ('reason' in projected) ctx.addIssue({ code: 'custom', message: projected.reason });
    }),
  deliveryMode: z.enum(['immediate', 'defer']).optional(),
});

export const SendMessageResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted'), mailboxId: z.string(), messageId: z.string() }),
  z.object({ kind: z.literal('rejected'), reason: z.string() }),
]);

type SendInput = z.infer<typeof SendMessageInputSchema>;
type SendResult = z.infer<typeof SendMessageResultSchema>;

function admitOperationMessage(
  input: SendInput,
  caller: OperationCaller
): { value: SendInput } | { reason: SendResult } {
  return caller.source === 'mcp' && input.message.inputKind === 'human'
    ? { reason: { kind: 'rejected', reason: 'MCP callers cannot claim human input provenance' } }
    : { value: input };
}

export function selectMessageOrigin(caller: OperationCaller): string {
  if (caller.sessionId) return renderAddress({ kind: 'session', sessionId: caller.sessionId });
  return caller.source === 'rpc' ? 'chat' : 'system';
}

export function persistOperationMessage(
  input: SendInput,
  origin: string,
  messageId: string,
  jobQueue: JobQueueRepository
): Promise<MailboxHandoffOutcome> {
  return handoffPromptToMailbox({
    to: renderAddress({ kind: 'session', sessionId: input.sessionId }),
    message: input.message,
    origin,
    messageUuid: messageId,
    deliveryMode: input.deliveryMode,
    jobQueue,
  });
}

export function mapMessageReceipt(outcome: MailboxHandoffOutcome, messageId: string): SendResult {
  return outcome.kind === 'enqueued'
    ? { kind: 'accepted', mailboxId: outcome.id, messageId }
    : { kind: 'rejected', reason: outcome.reason };
}

const runSendMessage = (superpipe({})('send-operation-message') as PipelineAPI)
  .input(['input', 'caller', 'jobQueue'])
  .pipe(admitOperationMessage, ['input', 'caller'], 'result:receipt')
  .pipe(generateUUID, undefined, 'messageId')
  .pipe(selectMessageOrigin, 'caller', 'origin')
  .pipe(persistOperationMessage, ['receipt', 'origin', 'messageId', 'jobQueue'], 'handoff')
  .pipe(mapMessageReceipt, ['handoff', 'messageId'], 'receipt')
  .endAsync('receipt') as (
  input: SendInput,
  caller: OperationCaller,
  jobQueue: JobQueueRepository
) => Promise<SendResult>;

export function createSendMessageOperation(jobQueue: JobQueueRepository) {
  return defineOperation({
    name: 'message.send',
    description:
      'Persist a message for a session in this daemon. Acceptance does not mean the session has processed it or replied.',
    inputSchema: SendMessageInputSchema,
    resultSchema: SendMessageResultSchema,
    execute: (input, caller) => runSendMessage(input, caller, jobQueue),
  });
}

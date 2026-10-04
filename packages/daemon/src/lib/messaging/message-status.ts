import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { SendStatus as MessageSendStatus } from '../../storage/repositories/sdk-message-repository.ts';
import { defineOperation } from '../operations/registry.ts';

export const MessageStatusInputSchema = z.object({
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
});

const DeliveryState = z.enum([
  'queued',
  'deferred',
  'processing',
  'delivered',
  'failed',
  'unknown',
]);

export const MessageStatusResultSchema = z.object({
  status: DeliveryState,
  reason: z.string().optional(),
});

type MessageStatusInput = z.infer<typeof MessageStatusInputSchema>;
type MessageStatusResult = z.infer<typeof MessageStatusResultSchema>;

export interface MailboxAdmission {
  status: string;
  error: string | null;
}

export interface MessageStatusReaders {
  readSendStatus(sessionId: string, messageId: string): MessageSendStatus | null;
  readMailboxAdmission(sessionId: string, messageId: string): MailboxAdmission | null;
  readDeliveryError(sessionId: string, messageId: string): string | null;
}

const ROW_STATES: Record<MessageSendStatus, MessageStatusResult['status']> = {
  enqueued: 'queued',
  deferred: 'deferred',
  submitted: 'processing',
  consumed: 'delivered',
  failed: 'failed',
};

export function readMessageEvidence(input: MessageStatusInput, readers: MessageStatusReaders) {
  return {
    sendStatus: readers.readSendStatus(input.sessionId, input.messageId),
    admission: readers.readMailboxAdmission(input.sessionId, input.messageId),
  };
}

export function classifyMessageDelivery(evidence: {
  sendStatus: MessageSendStatus | null;
  admission: MailboxAdmission | null;
}): MessageStatusResult['status'] {
  if (evidence.sendStatus) return ROW_STATES[evidence.sendStatus] ?? 'unknown';
  const admission = evidence.admission;
  if (admission?.status === 'pending' || admission?.status === 'processing') return 'queued';
  return admission?.status === 'dead' ? 'failed' : 'unknown';
}

export function explainMessageFailure(
  status: MessageStatusResult['status'],
  input: MessageStatusInput,
  evidence: { admission: MailboxAdmission | null },
  readers: MessageStatusReaders
): MessageStatusResult {
  if (status !== 'failed') return { status };
  const reason =
    (evidence.admission?.status === 'dead' ? evidence.admission.error : null) ??
    readers.readDeliveryError(input.sessionId, input.messageId);
  return reason ? { status, reason } : { status };
}

const runMessageStatus = (superpipe({})('read-message-status') as PipelineAPI)
  .input(['input', 'readers'])
  .pipe(readMessageEvidence, ['input', 'readers'], 'evidence')
  .pipe(classifyMessageDelivery, 'evidence', 'status')
  .pipe(explainMessageFailure, ['status', 'input', 'evidence', 'readers'], 'result')
  .end('result') as (
  input: MessageStatusInput,
  readers: MessageStatusReaders
) => MessageStatusResult;

export function createMessageStatusOperation(readers: MessageStatusReaders) {
  return defineOperation({
    name: 'message.status',
    description:
      'Read where a message sent with message.send is now, by its target sessionId and the messageId from the send receipt: queued, deferred, processing (the target is running a turn on it), delivered (the target consumed it), failed (with the reason, such as an archived target or an expired or erroring delivery) or unknown. Delivered means the target read the message, not that it replied.',
    inputSchema: MessageStatusInputSchema,
    resultSchema: MessageStatusResultSchema,
    execute: async (input) => runMessageStatus(input, readers),
  });
}

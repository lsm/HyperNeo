import { generateUUID } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import {
  isValidAddress,
  parseRemoteAddress,
  renderAddress,
  type RemoteSessionAddress,
} from '../mailbox/address.ts';
import { toMailboxMessage } from '../mailbox/entry.ts';
import { handoffPromptToMailbox, type MailboxHandoffOutcome } from '../mailbox/handoff.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { AgentReferenceSchema } from '../agents/agent-reference.ts';
import { sessionUnavailable } from '../session-resolution/session-lookup.ts';

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

export const MessageSessionIdSchema = z
  .string()
  .min(1)
  .refine(
    (sessionId) => isValidAddress({ kind: 'session', sessionId }),
    'Session ID must be URI-encodable'
  );

export const SendMessageInputSchema = z
  .object({
    sessionId: MessageSessionIdSchema.optional(),
    agent: AgentReferenceSchema.optional(),
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
              type: z.enum(['file', 'folder']),
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
  })
  .refine((input) => (input.sessionId === undefined) !== (input.agent === undefined), {
    message: 'Address the message with exactly one of sessionId or agent',
  });

export const SendMessageResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted'), mailboxId: z.string(), messageId: z.string() }),
  z.object({ kind: z.literal('rejected'), reason: z.string() }),
]);

type SendRequest = z.infer<typeof SendMessageInputSchema>;
type SendInput = Omit<SendRequest, 'sessionId' | 'agent'> & { sessionId: string };
type SendResult = z.infer<typeof SendMessageResultSchema>;

export type SessionStatusRead = (sessionId: string) => string | null;

export type RemoteSendForwarder = (
  target: RemoteSessionAddress,
  input: SendInput
) => Promise<SendResult>;

export type AgentTargetResolver = (
  ref: NonNullable<SendRequest['agent']>
) => Promise<{ value: string } | { reason: string }>;

const rejectAgentTargets: AgentTargetResolver = () =>
  Promise.resolve({ reason: 'Agent addressing is not available here' });

export async function resolveMessageTarget(
  request: SendRequest,
  resolveAgent: AgentTargetResolver
): Promise<{ value: SendInput } | { reason: SendResult }> {
  const { agent, sessionId, ...rest } = request;
  if (!agent) return { value: { ...rest, sessionId: sessionId as string } };
  const resolved = await resolveAgent(agent);
  return 'value' in resolved
    ? { value: { ...rest, sessionId: resolved.value } }
    : { reason: { kind: 'rejected', reason: resolved.reason } };
}

const rejectUnattachedDaemon: RemoteSendForwarder = (target) =>
  Promise.resolve({ kind: 'rejected', reason: `No attached daemon: ${target.daemonId}` });

export function forwardRemoteMessage(
  input: SendInput,
  forwardRemote: RemoteSendForwarder
): Promise<{ value: SendInput } | { reason: SendResult }> {
  const target = parseRemoteAddress(input.sessionId);
  return target === null
    ? Promise.resolve({ value: input })
    : forwardRemote(target, input).then((reason) => ({ reason }));
}

export function requireTargetSession(
  input: SendInput,
  sessionStatus: SessionStatusRead
): { value: SendInput } | { reason: SendResult } {
  const status = sessionStatus(input.sessionId);
  if (status === null)
    return { reason: { kind: 'rejected', reason: `Unknown session: ${input.sessionId}` } };
  return sessionUnavailable(status)
    ? {
        reason: {
          kind: 'rejected',
          reason: `Session ${input.sessionId} is ${status} and cannot receive messages`,
        },
      }
    : { value: input };
}

function admitOperationMessage(
  input: SendRequest,
  caller: OperationCaller
): { value: SendRequest } | { reason: SendResult } {
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
  .input(['input', 'caller', 'jobQueue', 'sessionStatus', 'forwardRemote', 'resolveAgent'])
  .pipe(admitOperationMessage, ['input', 'caller'], 'result:receipt')
  .pipe(resolveMessageTarget, ['receipt', 'resolveAgent'], 'result:receipt')
  .pipe(forwardRemoteMessage, ['receipt', 'forwardRemote'], 'result:receipt')
  .pipe(requireTargetSession, ['receipt', 'sessionStatus'], 'result:receipt')
  .pipe(generateUUID, undefined, 'messageId')
  .pipe(selectMessageOrigin, 'caller', 'origin')
  .pipe(persistOperationMessage, ['receipt', 'origin', 'messageId', 'jobQueue'], 'handoff')
  .pipe(mapMessageReceipt, ['handoff', 'messageId'], 'receipt')
  .endAsync('receipt') as (
  input: SendRequest,
  caller: OperationCaller,
  jobQueue: JobQueueRepository,
  sessionStatus: SessionStatusRead,
  forwardRemote: RemoteSendForwarder,
  resolveAgent: AgentTargetResolver
) => Promise<SendResult>;

export function createSendMessageOperation(
  jobQueue: JobQueueRepository,
  sessionStatus: SessionStatusRead,
  forwardRemote: RemoteSendForwarder = rejectUnattachedDaemon,
  resolveAgent: AgentTargetResolver = rejectAgentTargets
) {
  return defineOperation({
    name: 'message.send',
    description:
      'Persist a message for a session, addressed by session id or by agent {space, agent}, and not restricted to the caller Space. An agent target names the space by id, slug or name and the agent by id, @handle or display name; it finds or starts that agent\'s session, and an unknown or ambiguous name is rejected with the candidates. Rejects an unknown session id and a session that is archived or ended. A session on an attached remote daemon is addressed as "daemon:<daemonId>::session:<sessionId>"; that send is forwarded to the remote daemon, whose mailbox owns the message, and fails if the daemon is unattached or unreachable. Acceptance means the message is queued for that session, not that the session has processed it or replied.',
    inputSchema: SendMessageInputSchema,
    resultSchema: SendMessageResultSchema,
    execute: (input, caller) =>
      runSendMessage(input, caller, jobQueue, sessionStatus, forwardRemote, resolveAgent),
  });
}

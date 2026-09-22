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
import {
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
} from '../operations/registry.ts';

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

const MessageEnvelopeSchema = z
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
  });

const DeliveryModeSchema = z.enum(['immediate', 'defer']);

const SessionRecipientSchema = z.strictObject({
  kind: z.literal('session'),
  sessionId: z
    .string()
    .min(1)
    .refine(
      (sessionId) => isValidAddress({ kind: 'session', sessionId }),
      'Session ID must be URI-encodable'
    ),
});

const SpaceSessionRecipientSchema = z.strictObject({
  kind: z.literal('spaceSession'),
  spaceId: z.string().min(1),
  sessionId: z.string().min(1),
  answerQuestion: z.boolean().optional(),
});

const SenderLevelSchema = z.enum([
  'long-horizon-agent',
  'task-agent',
  'node-agent',
  'session-agent',
]);

const taskRecipientShape = {
  kind: z.literal('task'),
  spaceId: z.string().min(1),
  nodeId: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
  mySessionId: z.string().min(1).optional(),
  outboundSenderLevel: SenderLevelSchema,
  outboundSenderDisplayName: z.string().min(1),
  outboundReplyTargetHandle: z.string().nullable().optional(),
};

const TaskRecipientSchema = z.union([
  z.strictObject({ ...taskRecipientShape, taskId: z.string().min(1) }),
  z.strictObject({ ...taskRecipientShape, taskNumber: z.number().int().positive() }),
]);

const PeerRecipientSchema = z.strictObject({
  kind: z.literal('peer'),
  target: z.union([z.string(), z.array(z.string())]),
});

export const SendMessageInputSchema = z.union([
  z.object({
    to: SessionRecipientSchema,
    message: MessageEnvelopeSchema,
    deliveryMode: DeliveryModeSchema.optional(),
  }),
  z.object({
    to: SpaceSessionRecipientSchema,
    message: z.string().min(1),
  }),
  z.strictObject({
    to: TaskRecipientSchema,
    message: z.string().min(1).max(100_000),
  }),
  z.strictObject({
    to: PeerRecipientSchema,
    message: z.string().min(1),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export const SendMessageResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted'), mailboxId: z.string(), messageId: z.string() }),
  z.object({ kind: z.literal('rejected'), reason: z.string() }),
]);

type MessageSendInput = z.infer<typeof SendMessageInputSchema>;
type SendResult = z.infer<typeof SendMessageResultSchema>;

export type SessionSendInput = {
  readonly sessionId: string;
  readonly message: z.infer<typeof MessageEnvelopeSchema>;
  readonly deliveryMode?: z.infer<typeof DeliveryModeSchema>;
};

export type SessionExistenceCheck = (sessionId: string) => boolean;

export type RemoteSendForwarder = (
  target: RemoteSessionAddress,
  input: SessionSendInput
) => Promise<SendResult>;

export interface MessageSendArms {
  readonly spaceSession?: OperationDefinition;
  readonly task?: OperationDefinition;
  readonly peer?: OperationDefinition;
}

type SendArm = (caller: OperationCaller) => Promise<unknown>;

const rejectUnattachedDaemon: RemoteSendForwarder = (target) =>
  Promise.resolve({ kind: 'rejected', reason: `No attached daemon: ${target.daemonId}` });

export function forwardRemoteMessage(
  input: SessionSendInput,
  forwardRemote: RemoteSendForwarder
): Promise<{ value: SessionSendInput } | { reason: SendResult }> {
  const target = parseRemoteAddress(input.sessionId);
  return target === null
    ? Promise.resolve({ value: input })
    : forwardRemote(target, input).then((reason) => ({ reason }));
}

export function requireTargetSession(
  input: SessionSendInput,
  sessionExists: SessionExistenceCheck
): { value: SessionSendInput } | { reason: SendResult } {
  return sessionExists(input.sessionId)
    ? { value: input }
    : {
        reason: {
          kind: 'rejected',
          reason: `Unknown session: ${input.sessionId}`,
        },
      };
}

function admitOperationMessage(
  input: SessionSendInput,
  caller: OperationCaller
): { value: SessionSendInput } | { reason: SendResult } {
  return caller.source === 'mcp' && input.message.inputKind === 'human'
    ? { reason: { kind: 'rejected', reason: 'MCP callers cannot claim human input provenance' } }
    : { value: input };
}

export function selectMessageOrigin(caller: OperationCaller): string {
  if (caller.sessionId) return renderAddress({ kind: 'session', sessionId: caller.sessionId });
  return caller.source === 'rpc' ? 'chat' : 'system';
}

export function persistOperationMessage(
  input: SessionSendInput,
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

const runSessionSend = (superpipe({})('send-session-mailbox-message') as PipelineAPI)
  .input(['input', 'caller', 'jobQueue', 'sessionExists', 'forwardRemote'])
  .pipe(admitOperationMessage, ['input', 'caller'], 'result:receipt')
  .pipe(forwardRemoteMessage, ['receipt', 'forwardRemote'], 'result:receipt')
  .pipe(requireTargetSession, ['receipt', 'sessionExists'], 'result:receipt')
  .pipe(generateUUID, undefined, 'messageId')
  .pipe(selectMessageOrigin, 'caller', 'origin')
  .pipe(persistOperationMessage, ['receipt', 'origin', 'messageId', 'jobQueue'], 'handoff')
  .pipe(mapMessageReceipt, ['handoff', 'messageId'], 'receipt')
  .endAsync('receipt') as (
  input: SessionSendInput,
  caller: OperationCaller,
  jobQueue: JobQueueRepository,
  sessionExists: SessionExistenceCheck,
  forwardRemote: RemoteSendForwarder
) => Promise<SendResult>;

function recipientFields<Recipient extends { kind: string }>(
  to: Recipient
): Omit<Recipient, 'kind'> {
  const { kind: _kind, ...fields } = to;
  return fields;
}

async function delegateToArm(
  arm: OperationDefinition | undefined,
  kind: RecipientKind,
  input: unknown
): Promise<{ value: SendArm } | { reason: SendResult }> {
  if (!arm) {
    return {
      reason: {
        kind: 'rejected',
        reason: `message.send cannot address a ${kind} recipient on this daemon`,
      },
    };
  }
  const parsed = await arm.inputSchema.safeParseAsync(input);
  return parsed.success
    ? { value: (caller) => arm.execute(parsed.data, caller) }
    : {
        reason: {
          kind: 'rejected',
          reason: `message.send could not address a ${kind} recipient: ${parsed.error.message}`,
        },
      };
}

type RecipientKind = MessageSendInput['to']['kind'];

function addressed<Kind extends RecipientKind>(
  input: MessageSendInput,
  kind: Kind
): input is Extract<MessageSendInput, { to: { kind: Kind } }> {
  return input.to.kind === kind;
}

export function routeMessageSend(
  input: MessageSendInput,
  arms: MessageSendArms,
  sendToSession: (payload: SessionSendInput, caller: OperationCaller) => Promise<SendResult>
): Promise<{ value: SendArm } | { reason: SendResult }> {
  if (addressed(input, 'session')) {
    const payload: SessionSendInput = {
      sessionId: input.to.sessionId,
      message: input.message,
      ...(input.deliveryMode === undefined ? {} : { deliveryMode: input.deliveryMode }),
    };
    return Promise.resolve({ value: (caller) => sendToSession(payload, caller) });
  }
  if (addressed(input, 'spaceSession')) {
    return delegateToArm(arms.spaceSession, 'spaceSession', {
      ...recipientFields(input.to),
      message: input.message,
    });
  }
  if (addressed(input, 'task')) {
    return delegateToArm(arms.task, 'task', {
      ...recipientFields(input.to),
      message: input.message,
    });
  }
  return delegateToArm(arms.peer, 'peer', {
    ...recipientFields(input.to),
    message: input.message,
    ...(input.data === undefined ? {} : { data: input.data }),
  });
}

function runSendArm(arm: SendArm, caller: OperationCaller): Promise<unknown> {
  return arm(caller);
}

const runMessageSend = (superpipe({})('message-send') as PipelineAPI)
  .input(['input', 'caller', 'arms', 'sendToSession'])
  .pipe(routeMessageSend, ['input', 'arms', 'sendToSession'], 'result:receipt')
  .pipe(runSendArm, ['receipt', 'caller'], 'receipt')
  .endAsync('receipt') as (
  input: MessageSendInput,
  caller: OperationCaller,
  arms: MessageSendArms,
  sendToSession: (payload: SessionSendInput, caller: OperationCaller) => Promise<SendResult>
) => Promise<unknown>;

export function mergeSendResultSchemas(arms: MessageSendArms): z.ZodType<unknown> {
  const armSchemas = [arms.task, arms.peer, arms.spaceSession]
    .filter((arm): arm is OperationDefinition => arm !== undefined)
    .map((arm) => arm.resultSchema as z.ZodType<unknown>);
  return armSchemas.length === 0
    ? (SendMessageResultSchema as z.ZodType<unknown>)
    : (z.union([
        SendMessageResultSchema as z.ZodType<unknown>,
        ...armSchemas,
      ]) as z.ZodType<unknown>);
}

const MESSAGE_SEND_DESCRIPTION =
  'Send one message, with the recipient chosen by "to". to.kind "session" persists an SDK user message for a session addressed by id and not restricted to the caller Space; a session on an attached remote daemon is addressed as "daemon:<daemonId>::session:<sessionId>" and that send is forwarded to the remote daemon, whose mailbox owns the message. to.kind "spaceSession" sends a plain message to an ad-hoc session in a Space and, with answerQuestion, clears a pending question instead. to.kind "task" reaches a workflow node agent or long-horizon agent on a task, resolving the recipient by node_id, @handle, @role, @worker or @session and activating the node when it has no live session. to.kind "peer" is the node-agent door: a DM by agent name, fan-out by node name, multicast by array or broadcast with "*", validated against channel topology, with the sender resolved from the calling node-agent session and workflow send_message hooks running around the delivery. Acceptance means the message was queued or delivered, not that the recipient has processed it.';

export function createSendMessageOperation(
  jobQueue: JobQueueRepository,
  sessionExists: SessionExistenceCheck,
  forwardRemote: RemoteSendForwarder = rejectUnattachedDaemon,
  arms: MessageSendArms = {}
) {
  const sendToSession = (payload: SessionSendInput, caller: OperationCaller) =>
    runSessionSend(payload, caller, jobQueue, sessionExists, forwardRemote);
  return defineOperation({
    name: 'message.send',
    policy: { safetyClass: 'mutate' },
    description: MESSAGE_SEND_DESCRIPTION,
    inputSchema: SendMessageInputSchema,
    resultSchema: mergeSendResultSchemas(arms),
    execute: (input, caller) => runMessageSend(input, caller, arms, sendToSession),
  });
}

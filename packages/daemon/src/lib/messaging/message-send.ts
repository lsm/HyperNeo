import { createHash } from 'node:crypto';
import { publishTextHandoff } from '../handoffs/publish-text.ts';
import { getDataDir } from '../data-dir.ts';
import { canonicalJson } from '../agent/prompt-comparison.ts';
import { HandoffReference, readHandoff } from '../handoffs/outbox.ts';
import { enqueueMailboxEntry } from '../mailbox/enqueue.ts';
import { generateUUID } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import {
  isValidAddress,
  parseAddress,
  parseRemoteAddress,
  renderRemoteAddress,
  renderAddress,
  type RemoteSessionAddress,
} from '../mailbox/address.ts';
import { createMailboxEntry, toMailboxMessage } from '../mailbox/entry.ts';
import { WORKER_REPORT_KINDS } from '@hyperneo/shared/types/worker-report';
import { handoffPromptToMailbox, type MailboxHandoffOutcome } from '../mailbox/handoff.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { AgentReferenceSchema } from '../agents/agent-reference.ts';
import { sessionUnavailable } from '../session-resolution/session-lookup.ts';
import { wrapSessionContent } from './session-envelope.ts';

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

export const SessionContentSchema = z.union([
  z.string().min(1),
  z.array(ContentBlockSchema).min(1),
]);

export const SendMessageInputSchema = z
  .object({
    sessionId: MessageSessionIdSchema.optional(),
    agent: AgentReferenceSchema.optional(),
    message: z
      .object({
        type: z.literal('user'),
        message: z.object({
          role: z.literal('user').optional(),
          content: SessionContentSchema,
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
      })
      .optional(),
    to: z.union([MessageSessionIdSchema, AgentReferenceSchema]).optional(),
    text: z.string().min(1).optional(),
    kind: z.enum(WORKER_REPORT_KINDS).optional(),
    question: z
      .strictObject({
        todoId: z.string().min(1),
        title: z.string().min(1),
        options: z.array(z.string()),
        language: z.enum(['en', 'zh-Hans']),
      })
      .optional(),
    files: z
      .array(HandoffReference)
      .max(
        20,
        'At most 20 published file references per send; send additional references in another message'
      )
      .optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    deliveryMode: z.enum(['immediate', 'defer']).optional(),
    from: z.string().min(1).max(500).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.question && !['question', 'blocked'].includes(input.kind ?? ''))
      ctx.addIssue({ code: 'custom', message: 'question requires kind question or blocked' });
    const simple = input.to !== undefined || input.text !== undefined || input.files !== undefined;
    const valid = simple
      ? input.to !== undefined &&
        input.text !== undefined &&
        input.message === undefined &&
        input.sessionId === undefined &&
        input.agent === undefined
      : input.message !== undefined &&
        (input.sessionId === undefined) !== (input.agent === undefined);
    if (!valid)
      ctx.addIssue({
        code: 'custom',
        message: 'Use {to, text, files?} or an SDK message with exactly one of sessionId or agent',
      });
  })
  .transform(({ to, text, files, ...input }) => ({
    ...input,
    ...(to === undefined ? {} : typeof to === 'string' ? { sessionId: to } : { agent: to }),
    message: input.message ?? {
      type: 'user' as const,
      message: { content: text! },
      parent_tool_use_id: null,
    },
    ...(text === undefined ? {} : { handoff: { text, files: files ?? [] } }),
  }))
  .meta({
    examples: [
      { to: 'session-id', text: 'Report' },
      {
        sessionId: 'session-id',
        message: { type: 'user', message: { content: 'Report' }, parent_tool_use_id: null },
      },
    ],
  });

export const SendMessageResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('accepted'),
    mailboxId: z.string(),
    messageId: z.string(),
    files: z.array(HandoffReference).optional(),
  }),
  z.object({ kind: z.literal('rejected'), reason: z.string() }),
]);

type SendRequest = z.infer<typeof SendMessageInputSchema>;
type SendInput = Omit<SendRequest, 'sessionId' | 'agent'> & { sessionId: string };
type Retry = { key: string; fingerprint: string };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
type SendResult = z.infer<typeof SendMessageResultSchema>;
export type SessionReportHandler = (
  input: SendInput,
  origin: string,
  retry: Retry | undefined
) => Promise<SendResult | null>;

export type SessionStatusRead = (sessionId: string) => string | null;
export type SessionTitleRead = (sessionId: string) => string | null | Promise<string | null>;
export type SessionSendLimiter = {
  admit(origin: string, to: string, text: string): string | null;
  release(origin: string, to: string, text: string): void;
};

const SESSION_SEND_WINDOW_MS = 60_000;
const SESSION_SENDS_PER_WINDOW = 6;
const SESSION_DEDUPE_MS = 10 * 60_000;

export function createSessionSendLimiter(now: () => number = Date.now): SessionSendLimiter {
  const sends = new Map<string, number[]>();
  const seen = new Map<string, number>();
  const recent = (pair: string, at: number) =>
    (sends.get(pair) ?? []).filter((sentAt) => at - sentAt < SESSION_SEND_WINDOW_MS);
  return {
    admit: (origin, to, text) => {
      const at = now();
      for (const [key, sentAt] of seen) if (at - sentAt >= SESSION_DEDUPE_MS) seen.delete(key);
      const pair = `${origin}\n${to}`;
      if (seen.has(`${pair}\n${text}`))
        return 'duplicate: the same message reached this session in the last 10 minutes';
      const sent = recent(pair, at);
      if (sent.length >= SESSION_SENDS_PER_WINDOW)
        return `rate_limited: at most ${SESSION_SENDS_PER_WINDOW} messages a minute to one session`;
      sends.set(pair, [...sent, at]);
      seen.set(`${pair}\n${text}`, at);
      return null;
    },
    release: (origin, to, text) => {
      const pair = `${origin}\n${to}`;
      const reserved = seen.get(`${pair}\n${text}`);
      seen.delete(`${pair}\n${text}`);
      sends.set(
        pair,
        (sends.get(pair) ?? []).filter((sentAt) => sentAt !== reserved)
      );
    },
  };
}

const sentText = (input: SendInput) => JSON.stringify(input.message.message.content);

export function sessionSender(origin: string): string | null {
  const local = parseAddress(origin);
  if (local?.kind === 'session') return local.sessionId;
  return parseRemoteAddress(origin) === null ? null : origin;
}

export type SessionSent = {
  messageId: string;
  fromSession: string;
  toSession: string;
  text: string;
  at: number;
};
export type SessionSentObserver = (sent: SessionSent) => void | Promise<void>;

function plainText(content: SendInput['message']['message']['content']): string {
  return typeof content === 'string'
    ? content
    : content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

export async function reportSessionSend(
  receipt: SendResult,
  admitted: SendInput,
  origin: string,
  sent: SessionSentObserver
): Promise<void> {
  const fromSession = sessionSender(origin);
  if (receipt.kind === 'accepted' && fromSession)
    await sent({
      messageId: receipt.messageId,
      fromSession,
      toSession: admitted.sessionId,
      text: admitted.handoff?.text ?? plainText(admitted.message.message.content),
      at: Date.now(),
    });
}

export type RemoteSendForwarder = (
  target: RemoteSessionAddress,
  input: SendInput,
  origin: string
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
  origin: string,
  forwardRemote: RemoteSendForwarder
): Promise<{ value: SendInput } | { reason: SendResult }> {
  const target = parseRemoteAddress(input.sessionId);
  if (
    target &&
    input.handoff &&
    (input.handoff.files.length || Buffer.byteLength(input.handoff.text) > 4096)
  )
    return Promise.resolve({
      reason: {
        kind: 'rejected',
        reason: 'unavailable: remote artifact transfer is not supported',
      },
    });
  return target === null
    ? Promise.resolve({ value: input })
    : forwardRemote(target, input, origin).then((reason) => ({ reason }));
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

export function selectSendOrigin(input: { from?: string }, caller: OperationCaller): string {
  const relayed =
    input.from && (parseRemoteAddress(input.from) !== null || parseAddress(input.from) !== null);
  return caller.source === 'rpc' && relayed && input.from
    ? input.from
    : selectMessageOrigin(caller);
}

export function admitSessionSend(
  input: SendInput,
  origin: string,
  limit: SessionSendLimiter
): { value: SendInput } | { reason: SendResult } {
  if (sessionSender(origin) === null) return { value: input };
  const refused = limit.admit(origin, input.sessionId, sentText(input));
  return refused === null ? { value: input } : { reason: { kind: 'rejected', reason: refused } };
}

export function releaseUnsentSend(
  sent: SendResult,
  input: SendInput,
  origin: string,
  limit: SessionSendLimiter
): SendResult {
  if (sent.kind !== 'accepted' && sessionSender(origin) !== null)
    limit.release(origin, input.sessionId, sentText(input));
  return sent;
}

export async function stampSessionMessage(
  input: SendInput,
  origin: string,
  sessionTitle: SessionTitleRead
): Promise<SendInput> {
  const sender = sessionSender(origin);
  if (sender === null) return input;
  const name = await sessionTitle(sender);
  const content = wrapSessionContent(input.message.message.content, { sessionId: sender, name });
  return {
    ...input,
    message: {
      ...input.message,
      inputKind: 'task',
      message: { ...input.message.message, content } as SendInput['message']['message'],
    },
  };
}

function retryIdentity(input: SendRequest, origin: string): Retry | undefined {
  return input.idempotencyKey
    ? {
        key: digest(canonicalJson([origin, input.idempotencyKey])),
        fingerprint: digest(canonicalJson(input)),
      }
    : undefined;
}

function replaySend(
  input: SendRequest,
  retry: Retry | undefined,
  jobs: JobQueueRepository
): { value: SendRequest } | { reason: SendResult } {
  try {
    const receipt = retry ? jobs.submissionReceipt<SendResult>(retry.key, retry.fingerprint) : null;
    return receipt ? { reason: receipt } : { value: input };
  } catch (error) {
    return { reason: { kind: 'rejected', reason: String(error) } };
  }
}

async function prepareHandoff(
  input: SendInput,
  caller: OperationCaller,
  origin: string,
  limit: SessionSendLimiter
): Promise<{ value: SendInput } | { reason: SendResult }> {
  if (!input.handoff) return { value: input };
  try {
    const files = [...input.handoff.files];
    const dataDir = getDataDir();
    for (const ref of files) {
      if (caller.source !== 'rpc' && caller.role !== 'neo' && caller.sessionId !== ref.sessionId)
        throw new Error('session_scope');
      const checked = await readHandoff(dataDir, ref, 0, 0);
      if (checked.kind !== 'read') throw new Error(checked.kind);
    }
    let text = input.handoff.text;
    if (Buffer.byteLength(text) > 4096) {
      if (!caller.sessionId)
        throw new Error('session_required: publish large reports with handoff.publish');
      files.unshift(await publishTextHandoff(dataDir, caller.sessionId, text));
      text = 'Complete report attached. Read the hash-checked reference with handoff.read.';
    }
    return {
      value: {
        ...input,
        handoff: { ...input.handoff, files },
        message: {
          ...input.message,
          message: {
            ...input.message.message,
            content: files.length
              ? [
                  { type: 'text', text },
                  { type: 'text', text: JSON.stringify({ handoffFiles: files }) },
                ]
              : text,
          },
        },
      },
    };
  } catch (error) {
    return {
      reason: releaseUnsentSend(
        { kind: 'rejected', reason: error instanceof Error ? error.message : String(error) },
        input,
        origin,
        limit
      ),
    };
  }
}

async function persistOperationMessage(
  input: SendInput,
  origin: string,
  messageId: string,
  jobQueue: JobQueueRepository,
  retry: Retry | undefined
): Promise<SendResult> {
  const args = {
    to: renderAddress({ kind: 'session' as const, sessionId: input.sessionId }),
    message: { ...input.message, ...(input.kind ? { workerReportKind: input.kind } : {}) },
    origin,
    messageUuid: messageId,
    deliveryMode: input.deliveryMode,
    jobQueue,
  };
  const receipt = (outcome: MailboxHandoffOutcome): SendResult => {
    const result = mapMessageReceipt(outcome, messageId);
    return result.kind === 'accepted' && input.handoff?.files.length
      ? { ...result, files: input.handoff.files }
      : result;
  };
  if (!retry) return receipt(await handoffPromptToMailbox(args));
  try {
    return jobQueue.commitSubmissionReceipt(retry.key, retry.fingerprint, () => {
      const result = receipt(
        enqueueMailboxEntry(
          jobQueue,
          createMailboxEntry({ ...args, to: { kind: 'session', sessionId: input.sessionId } })
        )
      );
      if (result.kind === 'rejected') throw new Error(result.reason);
      return result;
    });
  } catch (error) {
    return { kind: 'rejected', reason: String(error) };
  }
}

export function mapMessageReceipt(outcome: MailboxHandoffOutcome, messageId: string): SendResult {
  return outcome.kind === 'enqueued'
    ? { kind: 'accepted', mailboxId: outcome.id, messageId }
    : { kind: 'rejected', reason: outcome.reason };
}

const runSendMessage = (superpipe({})('send-operation-message') as PipelineAPI)
  .input([
    'input',
    'caller',
    'jobQueue',
    'sessionStatus',
    'forwardRemote',
    'resolveAgent',
    'sessionTitle',
    'limit',
    'sent',
    'report',
  ])
  .pipe(admitOperationMessage, ['input', 'caller'], 'result:receipt')
  .pipe(selectSendOrigin, ['input', 'caller'], 'origin')
  .pipe(retryIdentity, ['input', 'origin'], 'retry')
  .pipe(replaySend, ['receipt', 'retry', 'jobQueue'], 'result:receipt')
  .pipe(resolveMessageTarget, ['receipt', 'resolveAgent'], 'result:receipt')
  .pipe(forwardRemoteMessage, ['receipt', 'origin', 'forwardRemote'], 'result:receipt')
  .pipe(requireTargetSession, ['receipt', 'sessionStatus'], 'result:receipt')
  .pipe(admitSessionSend, ['receipt', 'origin', 'limit'], 'result:receipt')
  .pipe((admitted: SendInput) => admitted, 'receipt', 'admitted')
  .pipe(prepareHandoff, ['receipt', 'caller', 'origin', 'limit'], 'result:receipt')
  .pipe(
    async (
      input: SendInput,
      origin: string,
      retry: Retry | undefined,
      report: SessionReportHandler,
      sent: SessionSentObserver
    ) => {
      const handled = await report(input, origin, retry);
      if (handled) await reportSessionSend(handled, input, origin, sent);
      return handled ? { reason: handled } : { value: input };
    },
    ['receipt', 'origin', 'retry', 'report', 'sent'],
    'result:receipt'
  )
  .pipe(stampSessionMessage, ['receipt', 'origin', 'sessionTitle'], 'outgoing')
  .pipe(generateUUID, undefined, 'messageId')
  .pipe(
    persistOperationMessage,
    ['outgoing', 'origin', 'messageId', 'jobQueue', 'retry'],
    'receipt'
  )
  .pipe(releaseUnsentSend, ['receipt', 'admitted', 'origin', 'limit'], 'receipt')
  .pipe(reportSessionSend, ['receipt', 'admitted', 'origin', 'sent'], 'reported')
  .endAsync('receipt') as (
  input: SendRequest,
  caller: OperationCaller,
  jobQueue: JobQueueRepository,
  sessionStatus: SessionStatusRead,
  forwardRemote: RemoteSendForwarder,
  resolveAgent: AgentTargetResolver,
  sessionTitle: SessionTitleRead,
  limit: SessionSendLimiter,
  sent: SessionSentObserver,
  report: SessionReportHandler
) => Promise<SendResult>;

export function createSendMessageOperation(
  jobQueue: JobQueueRepository,
  sessionStatus: SessionStatusRead,
  forwardRemote: RemoteSendForwarder = rejectUnattachedDaemon,
  resolveAgent: AgentTargetResolver = rejectAgentTargets,
  sessionTitle: SessionTitleRead = () => null,
  sent: SessionSentObserver = () => {},
  isNeo: (sessionId: string) => boolean = () => false,
  report: SessionReportHandler = async () => null
) {
  const ordinaryLimit = createSessionSendLimiter();
  const limit: SessionSendLimiter = {
    admit: (origin, to, text) => (isNeo(to) ? null : ordinaryLimit.admit(origin, to, text)),
    release: ordinaryLimit.release,
  };
  const forwardAndReport: RemoteSendForwarder = async (target, input, origin) => {
    const forwarded = await forwardRemote(target, input, origin);
    await reportSessionSend(
      forwarded,
      { ...input, sessionId: renderRemoteAddress(target) },
      origin,
      sent
    );
    return forwarded;
  };
  return defineOperation({
    name: 'message.send',
    description:
      'For question/blocked reports to Neo, include question:{todoId,title,options,language}; title and each of 2–6 options are one line of at most 80 characters in the human language (en or zh-Hans). This immediately opens or reuses the todo card, holds the todo and wakes Neo once. Unattributed reports wake Neo once for triage. ' +
      'Send {to, text, kind?, files?}; kind is the structured worker milestone done, blocked, question or failed (use done for PR milestones). Send reports through this operation instead of encoding a kind in text. files contains published handoff references. Text over 4 KiB UTF-8 is published in full in the bound sender outbox; accepted receipts include files. Optional idempotencyKey replays the same durable receipt, and conflicts if reused for different input. Same-user tampering is detected by hash, not prevented by OS isolation. The legacy SDK envelope also persists a message for a session, addressed by session id or by agent {space, agent}, and not restricted to the caller Space. An agent target names the space by id, slug or name and the agent by id, @handle or display name; it finds or starts that agent\'s session, and an unknown or ambiguous name is rejected with the candidates. Rejects an unknown session id and a session that is archived or ended. A session on an attached remote daemon is addressed as "daemon:<daemonId>::session:<sessionId>"; that send is forwarded to the remote daemon, whose mailbox owns the message, and fails if the daemon is unattached or unreachable. Acceptance means the message is queued for that session, not that the session has processed it or replied. A message from a session reaches the recipient as task input inside a daemon-written <session-message from-session=… from-name=…> envelope saying it is not from the human; it is injected into a running turn at the next tool round or wakes an idle session. Sends from a session to ordinary recipients are limited to 6 a minute, and identical text within 10 minutes is refused as a duplicate. Neo retains every report; unstructured notes wait for one ordered batch. Batches over 64 KiB are delivered as complete hash-checked files read with handoff.read. from is set by a daemon forwarding a send, as daemon:<sender daemon>::session:<id>; it is honored only from the RPC door, which is trusted as the local user, and only when it is an address.',
    inputSchema: SendMessageInputSchema,
    resultSchema: SendMessageResultSchema,
    execute: (input, caller) =>
      runSendMessage(
        input,
        caller,
        jobQueue,
        sessionStatus,
        forwardAndReport,
        resolveAgent,
        sessionTitle,
        limit,
        sent,
        report
      ),
  });
}

import type { UUID } from 'node:crypto';
import type { Session } from '@hyperneo/shared';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/database.ts';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { ensurePrompt, PromptContentConflictError } from '../agent/message-delivery-outbox.ts';
import { toMailboxMessage } from '../mailbox/entry.ts';
import { SendMessageInputSchema } from '../messaging/message-send.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';

const Input = z
  .object({
    sessionId: SendMessageInputSchema.shape.sessionId,
    requestId: z.uuid(),
    content: SendMessageInputSchema.shape.message.shape.message.shape.content,
  })
  .superRefine((input, context) => {
    const projected = toMailboxMessage({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: input.content },
    });
    if ('reason' in projected) context.addIssue({ code: 'custom', message: projected.reason });
  });
const Result = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    requestId: z.string(),
    messageId: z.string(),
    created: z.boolean(),
  }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
type IntakeInput = z.infer<typeof Input>;
type IntakeResult = z.infer<typeof Result>;
type Gate<T> = { value: T } | { reason: Extract<IntakeResult, { ok: false }> };
type Target = Pick<Session, 'id' | 'status' | 'config'>;

export function admitNeoIntake(input: IntakeInput, caller: OperationCaller): Gate<IntakeInput> {
  return caller.source === 'rpc' && caller.principal === 'local'
    ? { value: input }
    : { reason: { ok: false, reason: 'Only the human can submit a Neo ask.' } };
}

export function requireNeoIntakeTarget(
  input: IntakeInput,
  binding: NeoBinding | null,
  session: Target | null
): Gate<Target> {
  if (!binding || binding.sessionId !== input.sessionId || binding.kind === 'worker')
    return { reason: { ok: false, reason: 'Open a Neo conversation before sending.' } };
  if (!session || session.id !== input.sessionId || session.status === 'archived')
    return { reason: { ok: false, reason: 'This Neo conversation is no longer available.' } };
  return { value: session };
}

export function neoIntakeMessage(
  input: IntakeInput
): SDKUserMessage & { uuid: UUID; inputKind: 'human' } {
  return {
    type: 'user',
    uuid: input.requestId as UUID,
    session_id: input.sessionId,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content:
        typeof input.content === 'string' ? [{ type: 'text', text: input.content }] : input.content,
    },
    inputKind: 'human',
  };
}

export function persistNeoIntake(
  message: ReturnType<typeof neoIntakeMessage>,
  session: Target,
  db: Database
): IntakeResult {
  try {
    const receipt = ensurePrompt({
      db: db.getDatabase(),
      sdkMessageRepo: db.getSDKMessageRepo(),
      jobQueue: db.getJobQueueRepo(),
      sessionId: session.id,
      message,
      hold: session.config.queryMode === 'manual' ? 'manual' : 'immediate',
      delivery: { origin: 'chat' },
    });
    return {
      ok: true,
      requestId: message.uuid,
      messageId: message.uuid,
      created: receipt.created,
    };
  } catch (error) {
    if (error instanceof PromptContentConflictError)
      return { ok: false, reason: 'This request id already belongs to a different ask.' };
    throw error;
  }
}

const runIntake = (superpipe({})('neo-message-intake') as PipelineAPI)
  .input(['input', 'caller', 'db', 'repo'])
  .pipe(admitNeoIntake, ['input', 'caller'], 'result:receipt')
  .pipe(
    (input: IntakeInput, repo: NeoRepository) => repo.getBindingBySession(input.sessionId),
    ['receipt', 'repo'],
    'binding'
  )
  .pipe(
    (input: IntakeInput, db: Database) => db.getSession(input.sessionId),
    ['receipt', 'db'],
    'session'
  )
  .pipe(requireNeoIntakeTarget, ['receipt', 'binding', 'session'], 'result:receipt')
  .pipe(neoIntakeMessage, 'input', 'message')
  .pipe(persistNeoIntake, ['message', 'receipt', 'db'], 'receipt')
  .end('receipt') as (
  input: IntakeInput,
  caller: OperationCaller,
  db: Database,
  repo: NeoRepository
) => IntakeResult;

export function createNeoIntakeOperation(db: Database, repo: NeoRepository) {
  return defineOperation({
    name: 'neo.message.send',
    description:
      'Durably accept a human ask into an open Neo conversation without waiting for its coordinator. Supply a new requestId UUID per ask and reuse it only for retries of identical content. Acceptance does not mean the ask has been processed or answered.',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'human_only' },
    execute: async (input, caller) => runIntake(input, caller, db, repo),
  });
}

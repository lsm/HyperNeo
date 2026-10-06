import type { UUID } from 'node:crypto';
import type { Session } from '@hyperneo/shared';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/database.ts';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { NeoConversationAskRepository } from '../../storage/repositories/neo-conversation-ask-repository.ts';
import { NeoRoutingLogRepository } from '../../storage/repositories/neo-routing-log-repository.ts';
import { toMailboxMessage } from '../mailbox/entry.ts';
import { MessageSessionIdSchema, SendMessageInputSchema } from '../messaging/message-send.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { NeoRouteChoice, NeoRouted, NeoRouter, NeoRouteSignal } from './router.ts';

const Input = z
  .object({
    sessionId: MessageSessionIdSchema,
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
export type NeoIntakeNotifier = () => void;

const noNotification: NeoIntakeNotifier = () => {};

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
  input: IntakeInput,
  sessionId: string = input.sessionId
): SDKUserMessage & { uuid: UUID; inputKind: 'human' } {
  return {
    type: 'user',
    uuid: input.requestId as UUID,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content:
        typeof input.content === 'string' ? [{ type: 'text', text: input.content }] : input.content,
    },
    inputKind: 'human',
  };
}

export function requireNeoIntakeConversation(
  root: NeoBinding | null,
  session: Target | null
): Gate<string> {
  const id = root?.sessionId.startsWith('neo:') ? root.sessionId.slice(4) : null;
  return root?.kind === 'neo' &&
    root.concernId === null &&
    id &&
    z.uuid().safeParse(id).success &&
    session?.id === root.sessionId &&
    session.status !== 'archived'
    ? { value: id }
    : { reason: { ok: false, reason: 'The public Neo conversation is no longer available.' } };
}

export function persistNeoIntake(
  message: ReturnType<typeof neoIntakeMessage>,
  session: Target,
  db: Database,
  conversationId: string
): IntakeResult {
  const receipt = new NeoConversationAskRepository(db.getDatabase()).acceptPrompt(
    conversationId,
    message,
    session.config.queryMode === 'manual' ? 'manual' : 'immediate',
    db.getSDKMessageRepo(),
    db.getJobQueueRepo()
  );
  return receipt.accepted
    ? { ok: true, requestId: message.uuid, messageId: message.uuid, created: receipt.created }
    : {
        ok: false,
        reason:
          receipt.reason === 'ask_conflict'
            ? 'This request id already belongs to a different ask.'
            : 'This ask could not be admitted to the public conversation.',
      };
}

export function neoAskText(content: IntakeInput['content']): string {
  return typeof content === 'string'
    ? content
    : content
        .flatMap((block: { type: string; text?: string }) =>
          block.type === 'text' && block.text ? [block.text] : []
        )
        .join(' ');
}

type Routed = { binding: NeoBinding; target: Target; signal: string; confidence: number };

export function applyNeoRoute(
  binding: NeoBinding,
  target: Target,
  route: NeoRouteChoice | null,
  repo: NeoRepository,
  db: Database,
  fallback = 'opened'
): Routed {
  const opened = { binding, target, signal: fallback, confidence: 1 };
  if (binding.kind !== 'neo' || !route) return opened;
  const holder = repo.getBindingForConcern(route.concernId);
  const session = holder ? db.getSession(holder.sessionId) : null;
  return holder?.kind === 'concern' &&
    holder.sessionId === route.sessionId &&
    session &&
    session.status !== 'archived'
    ? { binding: holder, target: session, signal: route.signal, confidence: route.confidence }
    : opened;
}

export function logNeoRoute(
  receipt: IntakeResult,
  message: ReturnType<typeof neoIntakeMessage>,
  routed: Routed,
  conversationId: string,
  db: Database
): IntakeResult {
  if (!receipt.ok) return receipt;
  try {
    new NeoRoutingLogRepository(db.getDatabase()).record({
      messageId: message.uuid,
      conversationId,
      askedAt: Date.now(),
      ask: neoAskText(message.message.content) || '(attachment)',
      destination: routed.binding.kind === 'concern' ? 'holder' : 'main',
      targetSessionId: routed.binding.sessionId,
      concernId: routed.binding.concernId,
      signal: routed.signal,
      confidence: routed.confidence,
    });
  } catch {}
  return receipt;
}

export function notifyNeoIntakeAcceptance(
  receipt: IntakeResult,
  notify: NeoIntakeNotifier
): IntakeResult {
  if (receipt.ok) {
    try {
      notify();
    } catch {}
  }
  return receipt;
}

const runIntake = (superpipe({})('neo-message-intake') as PipelineAPI)
  .input(['input', 'caller', 'db', 'repo', 'notify', 'route', 'fallback'])
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
  .pipe((session: Target) => session, 'receipt', 'target')
  .pipe((repo: NeoRepository) => repo.getBindingForConcern(null), 'repo', 'root')
  .pipe(
    (root: NeoBinding | null, db: Database) =>
      root ? (db.getSession(root.sessionId) ?? null) : null,
    ['root', 'db'],
    'rootSession'
  )
  .pipe(requireNeoIntakeConversation, ['root', 'rootSession'], 'result:receipt')
  .pipe(applyNeoRoute, ['binding', 'target', 'route', 'repo', 'db', 'fallback'], 'routed')
  .pipe(
    (input: IntakeInput, routed: Routed) => neoIntakeMessage(input, routed.target.id),
    ['input', 'routed'],
    'message'
  )
  .pipe((conversationId: string) => conversationId, 'receipt', 'conversationId')
  .pipe((routed: Routed) => routed.target, 'routed', 'routedTarget')
  .pipe(persistNeoIntake, ['message', 'routedTarget', 'db', 'receipt'], 'receipt')
  .pipe(logNeoRoute, ['receipt', 'message', 'routed', 'conversationId', 'db'], 'receipt')
  .pipe(notifyNeoIntakeAcceptance, ['receipt', 'notify'], 'receipt')
  .end('receipt') as (
  input: IntakeInput,
  caller: OperationCaller,
  db: Database,
  repo: NeoRepository,
  notify: NeoIntakeNotifier,
  route: NeoRouteChoice | null,
  fallback?: string
) => IntakeResult;

type AskRoute = NeoRouted;

export function requireRoutableAsk(
  input: IntakeInput,
  caller: OperationCaller,
  repo: NeoRepository
): { value: IntakeInput } | { reason: AskRoute } {
  return 'value' in admitNeoIntake(input, caller) &&
    repo.getBindingBySession(input.sessionId)?.kind === 'neo'
    ? { value: input }
    : { reason: { choice: null } };
}

export function reuseLoggedRoute(
  input: IntakeInput,
  db: Database
): { value: IntakeInput } | { reason: AskRoute } {
  const earlier = new NeoRoutingLogRepository(db.getDatabase()).find(input.requestId);
  if (!earlier) return { value: input };
  return {
    reason: {
      choice:
        earlier.destination === 'holder' && earlier.concernId && earlier.targetSessionId
          ? {
              concernId: earlier.concernId,
              sessionId: earlier.targetSessionId,
              signal: earlier.signal.startsWith('classifier')
                ? (earlier.signal as NeoRouteSignal)
                : 'embedding',
              confidence: earlier.confidence ?? 0,
            }
          : null,
    },
  };
}

const routeNeoAsk = (superpipe({})('neo-ask-route') as PipelineAPI)
  .input(['input', 'caller', 'db', 'repo', 'router'])
  .pipe(requireRoutableAsk, ['input', 'caller', 'repo'], 'result:route')
  .pipe(reuseLoggedRoute, ['route', 'db'], 'result:route')
  .pipe(
    (input: IntakeInput, router: NeoRouter): Promise<AskRoute> => router(neoAskText(input.content)),
    ['route', 'router'],
    'route'
  )
  .endAsync('route') as (
  input: IntakeInput,
  caller: OperationCaller,
  db: Database,
  repo: NeoRepository,
  router: NeoRouter
) => Promise<AskRoute>;

export function createNeoIntakeOperation(
  db: Database,
  repo: NeoRepository,
  notify: NeoIntakeNotifier = noNotification,
  router?: NeoRouter
) {
  return defineOperation({
    name: 'neo.message.send',
    description:
      'Durably accept a human ask into an open Neo conversation without waiting for its coordinator. Supply a new requestId UUID per ask and reuse it only for retries of identical content. Acceptance does not mean the ask has been processed or answered.',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'human_only' },
    execute: (input, caller) =>
      router
        ? routeNeoAsk(input, caller, db, repo, router).then((route) =>
            runIntake(input, caller, db, repo, notify, route.choice, route.fallback)
          )
        : Promise.resolve(runIntake(input, caller, db, repo, notify, null)),
  });
}

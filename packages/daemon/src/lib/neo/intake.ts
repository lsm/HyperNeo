import type { UUID } from 'node:crypto';
import type { Session } from '@hyperneo/shared';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { NeoAsk, NeoQuestion, NeoReplyTo, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/database.ts';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import {
  type NeoConversationAskImageRow,
  NeoConversationAskRepository,
} from '../../storage/repositories/neo-conversation-ask-repository.ts';
import { neoImageSize } from './image-size.ts';
import { NeoRoutingLogRepository } from '../../storage/repositories/neo-routing-log-repository.ts';
import { NeoPublicationRepository } from '../../storage/repositories/neo-publication-repository.ts';
import { toMailboxMessage } from '../mailbox/entry.ts';
import { MessageSessionIdSchema, SendMessageInputSchema } from '../messaging/message-send.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { NeoRouted, NeoRouter, NeoRouteSignal } from './router.ts';
import { isMainNeoBinding } from './binding-roles.ts';
import { NeoReplyToSchema } from './conversation-ask.ts';

const Input = z
  .object({
    sessionId: MessageSessionIdSchema,
    requestId: z.uuid(),
    content: SendMessageInputSchema.shape.message.shape.message.shape.content,
    thumbnails: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(999_999),
            mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
            data: z.base64().max(44_000),
            width: z.number().int().positive().max(100_000).optional(),
            height: z.number().int().positive().max(100_000).optional(),
          })
          .strict()
      )
      .max(20)
      .optional(),
    replyTo: NeoReplyToSchema.optional(),
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
type NeoIntakeNotifier = (sessionId: string) => void;

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
  sessionId: string = input.sessionId,
  reply: NeoReply | null = null
): SDKUserMessage & {
  uuid: UUID;
  inputKind: 'human';
  replyTo?: NeoReplyTo;
  humanContent?: SDKUserMessage['message']['content'];
} {
  const content =
    typeof input.content === 'string'
      ? [{ type: 'text' as const, text: input.content }]
      : input.content;
  const fact = reply?.ask?.sessionId === sessionId ? neoReplyFact(reply) : null;
  return {
    type: 'user',
    uuid: input.requestId as UUID,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: fact ? [{ type: 'text', text: fact }, ...content] : content,
    },
    inputKind: 'human',
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(fact ? { humanContent: content } : {}),
  };
}

export type NeoReply = {
  replyTo: NeoReplyTo;
  ask: NeoAsk | null;
  question: NeoQuestion | null;
  todo: NeoTodo | null;
};

export function readNeoReply(
  replyTo: NeoReplyTo | undefined,
  store: NeoAskTodoRepository
): NeoReply | null {
  if (!replyTo) return null;
  const question = replyTo.kind === 'question' ? store.getQuestion(replyTo.id) : null;
  const todo = replyTo.kind === 'todo' ? store.getTodo(replyTo.id) : null;
  const askId = question?.askId ?? todo?.askId;
  return { replyTo, question, todo, ask: askId ? store.getAsk(askId) : null };
}

export function neoReplyFact(reply: NeoReply | null): string | null {
  if (reply?.question) return `The human answered your question "${reply.question.text}":`;
  return reply?.todo ? `The human replied about todo ${reply.todo.id}:` : null;
}

export function neoReplyAuthor(
  reply: NeoReply | null,
  publication: { producerInput: { sessionId: string } } | null
): string | null {
  return reply?.ask?.sessionId ?? publication?.producerInput.sessionId ?? null;
}

export function repliedNeoRoute(
  author: string | null,
  repo: NeoRepository
): { value: null } | { reason: NeoRouted } {
  if (!author) return { value: null };
  const holder = repo.getBindingBySession(author);
  return {
    reason: {
      choice:
        holder?.kind === 'project' && holder.projectId
          ? {
              projectId: holder.projectId,
              sessionId: holder.sessionId,
              signal: 'facts',
              confidence: 1,
            }
          : null,
      fallback: 'reply',
    },
  };
}

export function recordNeoReplyAnswer(
  receipt: IntakeResult,
  reply: NeoReply | null,
  input: IntakeInput,
  store: NeoAskTodoRepository,
  sessionId: string
): IntakeResult {
  const words = neoAskText(input.content).trim();
  if (
    receipt.ok &&
    words &&
    reply?.question?.state === 'open' &&
    reply.ask?.sessionId === sessionId
  )
    store.answerQuestion(reply.question, words, 'chat', Date.now());
  return receipt;
}

export function requireNeoIntakeConversation(
  root: NeoBinding | null,
  session: Target | null
): Gate<string> {
  const id = root?.sessionId.startsWith('neo:') ? root.sessionId.slice(4) : null;
  return isMainNeoBinding(root) &&
    id &&
    z.uuid().safeParse(id).success &&
    session?.id === root.sessionId &&
    session.status !== 'archived'
    ? { value: id }
    : { reason: { ok: false, reason: 'The public Neo conversation is no longer available.' } };
}

function persistNeoIntake(
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

export function neoIntakeImages(input: IntakeInput): NeoConversationAskImageRow[] {
  if (typeof input.content === 'string') return [];
  const thumbnails = new Map((input.thumbnails ?? []).map((thumb) => [thumb.index, thumb]));
  return input.content.flatMap((block, index) => {
    if (block.type !== 'image' || block.source.type !== 'base64') return [];
    const thumb = thumbnails.get(index);
    const read = neoImageSize(block.source.data);
    return [
      {
        index,
        width: read?.width ?? thumb?.width ?? null,
        height: read?.height ?? thumb?.height ?? null,
        thumbnail: thumb ? { mediaType: thumb.mediaType, data: thumb.data } : null,
      },
    ];
  });
}

function recordNeoIntakeImages(
  receipt: IntakeResult,
  input: IntakeInput,
  conversationId: string,
  db: Database
): IntakeResult {
  if (!receipt.ok) return receipt;
  try {
    const images = neoIntakeImages(input);
    if (images.length)
      new NeoConversationAskRepository(db.getDatabase()).recordImages(
        conversationId,
        receipt.requestId,
        images
      );
  } catch {}
  return receipt;
}

function neoAskText(content: IntakeInput['content']): string {
  return typeof content === 'string'
    ? content
    : content
        .flatMap((block: { type: string; text?: string }) =>
          block.type === 'text' && block.text ? [block.text] : []
        )
        .join(' ');
}

type Routed = {
  binding: NeoBinding;
  target: Target;
  signal: string;
  confidence: number;
  cause?: string;
};

function applyNeoRoute(
  binding: NeoBinding,
  target: Target,
  routed: NeoRouted,
  repo: NeoRepository,
  db: Database
): Routed {
  const route = routed.choice;
  const opened = {
    binding,
    target,
    signal: routed.fallback ?? 'opened',
    confidence: 1,
    ...(routed.cause ? { cause: routed.cause } : {}),
  };
  if (binding.kind !== 'neo' || !route) return opened;
  const holder = repo.getBindingForProject(route.projectId);
  const session = holder ? db.getSession(holder.sessionId) : null;
  return holder?.kind === 'project' &&
    holder.sessionId === route.sessionId &&
    session &&
    session.status !== 'archived'
    ? {
        binding: holder,
        target: session,
        signal: route.signal,
        confidence: route.confidence,
        ...(routed.cause ? { cause: routed.cause } : {}),
      }
    : opened;
}

function logNeoRoute(
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
      destination: routed.binding.kind === 'project' ? 'holder' : 'main',
      targetSessionId: routed.binding.sessionId,
      projectId: routed.binding.projectId,
      signal: routed.signal,
      confidence: routed.confidence,
      cause: routed.cause,
    });
  } catch {}
  return receipt;
}

function notifyNeoIntakeAcceptance(
  receipt: IntakeResult,
  notify: NeoIntakeNotifier,
  routed: Routed
): IntakeResult {
  if (receipt.ok) {
    try {
      notify(routed.target.id);
    } catch {}
  }
  return receipt;
}

export function wantsNeoRoute(
  binding: NeoBinding,
  router: NeoRouter | null
): { value: NeoRouter } | { reason: NeoRouted } {
  return binding.kind === 'neo' && router ? { value: router } : { reason: { choice: null } };
}

export function loggedNeoRoute(
  earlier: ReturnType<NeoRoutingLogRepository['find']>
): { value: null } | { reason: NeoRouted } {
  if (!earlier) return { value: null };
  return {
    reason: {
      choice:
        earlier.destination === 'holder' && earlier.projectId && earlier.targetSessionId
          ? {
              projectId: earlier.projectId,
              sessionId: earlier.targetSessionId,
              signal:
                earlier.signal === 'facts'
                  ? 'facts'
                  : earlier.signal.startsWith('classifier')
                    ? (earlier.signal as NeoRouteSignal)
                    : 'embedding',
              confidence: earlier.confidence ?? 0,
            }
          : null,
    },
  };
}

export function replayedNeoRoute(
  asked: { sessionId: string; holder: NeoBinding | null } | null,
  earlier: ReturnType<NeoRoutingLogRepository['find']>
): { value: null } | { reason: NeoRouted } {
  if (!asked) return loggedNeoRoute(earlier);
  if (earlier && earlier.targetSessionId === asked.sessionId) return loggedNeoRoute(earlier);
  const holder = asked.holder;
  return {
    reason: {
      choice:
        holder?.kind === 'project' && holder.projectId
          ? {
              projectId: holder.projectId,
              sessionId: asked.sessionId,
              signal: 'embedding',
              confidence: 1,
            }
          : null,
      fallback: 'replayed',
    },
  };
}

const routeNeoAsk = (superpipe({})('neo-ask-route') as PipelineAPI)
  .input(['input', 'binding', 'db', 'router', 'conversationId', 'repo', 'reply'])
  .pipe(
    (input: IntakeInput, db: Database, conversationId: string) =>
      input.replyTo?.kind === 'message'
        ? new NeoPublicationRepository(db.getDatabase()).get(conversationId, input.replyTo.id)
        : null,
    ['input', 'db', 'conversationId'],
    'publication'
  )
  .pipe(neoReplyAuthor, ['reply', 'publication'], 'author')
  .pipe(repliedNeoRoute, ['author', 'repo'], 'result:route')
  .pipe(wantsNeoRoute, ['binding', 'router'], 'result:route')
  .pipe(
    (input: IntakeInput, db: Database) =>
      new NeoRoutingLogRepository(db.getDatabase()).find(input.requestId),
    ['input', 'db'],
    'earlier'
  )
  .pipe(
    (input: IntakeInput, db: Database, conversationId: string, repo: NeoRepository) => {
      const asked = new NeoConversationAskRepository(db.getDatabase()).find(
        conversationId,
        input.requestId
      );
      return asked
        ? {
            sessionId: asked.askOrigin.sessionId,
            holder: repo.getBindingBySession(asked.askOrigin.sessionId),
          }
        : null;
    },
    ['input', 'db', 'conversationId', 'repo'],
    'asked'
  )
  .pipe(replayedNeoRoute, ['asked', 'earlier'], 'result:route')
  .pipe(
    (input: IntakeInput, router: NeoRouter): Promise<NeoRouted> =>
      router(neoAskText(input.content)),
    ['input', 'router'],
    'route'
  )
  .endAsync('route') as (
  input: IntakeInput,
  binding: NeoBinding,
  db: Database,
  router: NeoRouter | null,
  conversationId: string,
  repo: NeoRepository,
  reply: NeoReply | null
) => Promise<NeoRouted>;

type IntakeTarget = { binding: NeoBinding; target: Target; conversationId: string };

const readNeoIntakeTarget = (superpipe({})('neo-intake-target') as PipelineAPI)
  .input(['input', 'db', 'repo'])
  .pipe(
    (input: IntakeInput, repo: NeoRepository) => repo.getBindingBySession(input.sessionId),
    ['input', 'repo'],
    'binding'
  )
  .pipe(
    (input: IntakeInput, db: Database) => db.getSession(input.sessionId),
    ['input', 'db'],
    'session'
  )
  .pipe(requireNeoIntakeTarget, ['input', 'binding', 'session'], 'result:admission')
  .pipe((repo: NeoRepository) => repo.getBindingForProject(null), 'repo', 'root')
  .pipe(
    (root: NeoBinding | null, db: Database) =>
      root ? (db.getSession(root.sessionId) ?? null) : null,
    ['root', 'db'],
    'rootSession'
  )
  .pipe(requireNeoIntakeConversation, ['root', 'rootSession'], 'result:admission')
  .pipe(
    (binding: NeoBinding, target: Target, conversationId: string) => ({
      value: { binding, target, conversationId },
    }),
    ['binding', 'session', 'admission'],
    'result:admission'
  )
  .end('admission') as (
  input: IntakeInput,
  db: Database,
  repo: NeoRepository
) => IntakeTarget | Extract<IntakeResult, { ok: false }>;

function admitNeoIntakeTarget(
  input: IntakeInput,
  db: Database,
  repo: NeoRepository
): Gate<IntakeTarget> {
  const read = readNeoIntakeTarget(input, db, repo);
  return 'ok' in read ? { reason: read } : { value: read };
}

const runIntake = (superpipe({})('neo-message-intake') as PipelineAPI)
  .input(['input', 'caller', 'db', 'repo', 'notify', 'router', 'store'])
  .pipe(admitNeoIntake, ['input', 'caller'], 'result:receipt')
  .pipe(redirectNeoIntakeInput, ['input', 'repo'], 'input')
  .pipe(
    (input: IntakeInput, store: NeoAskTodoRepository) => readNeoReply(input.replyTo, store),
    ['input', 'store'],
    'reply'
  )
  .pipe(admitNeoIntakeTarget, ['input', 'db', 'repo'], 'result:receipt')
  .pipe(
    (
      input: IntakeInput,
      admitted: IntakeTarget,
      db: Database,
      router: NeoRouter | null,
      repo: NeoRepository,
      reply: NeoReply | null
    ) => routeNeoAsk(input, admitted.binding, db, router, admitted.conversationId, repo, reply),
    ['input', 'receipt', 'db', 'router', 'repo', 'reply'],
    'route'
  )
  .pipe(admitNeoIntakeTarget, ['input', 'db', 'repo'], 'result:receipt')
  .pipe(
    (fresh: IntakeTarget, route: NeoRouted, repo: NeoRepository, db: Database): Routed =>
      applyNeoRoute(fresh.binding, fresh.target, route, repo, db),
    ['receipt', 'route', 'repo', 'db'],
    'routed'
  )
  .pipe(
    (input: IntakeInput, routed: Routed, reply: NeoReply | null) =>
      neoIntakeMessage(input, routed.target.id, reply),
    ['input', 'routed', 'reply'],
    'message'
  )
  .pipe((fresh: IntakeTarget) => fresh.conversationId, 'receipt', 'conversationId')
  .pipe(
    (
      message: ReturnType<typeof neoIntakeMessage>,
      routed: Routed,
      db: Database,
      conversationId: string
    ) => persistNeoIntake(message, routed.target, db, conversationId),
    ['message', 'routed', 'db', 'conversationId'],
    'receipt'
  )
  .pipe(
    (
      receipt: IntakeResult,
      reply: NeoReply | null,
      input: IntakeInput,
      store: NeoAskTodoRepository,
      routed: Routed
    ) => recordNeoReplyAnswer(receipt, reply, input, store, routed.target.id),
    ['receipt', 'reply', 'input', 'store', 'routed'],
    'receipt'
  )
  .pipe(recordNeoIntakeImages, ['receipt', 'input', 'conversationId', 'db'], 'receipt')
  .pipe(logNeoRoute, ['receipt', 'message', 'routed', 'conversationId', 'db'], 'receipt')
  .pipe(notifyNeoIntakeAcceptance, ['receipt', 'notify', 'routed'], 'receipt')
  .endAsync('receipt') as (
  input: IntakeInput,
  caller: OperationCaller,
  db: Database,
  repo: NeoRepository,
  notify: NeoIntakeNotifier,
  router: NeoRouter | null,
  store: NeoAskTodoRepository
) => Promise<IntakeResult>;

export function redirectNeoIntakeInput(input: IntakeInput, repo: NeoRepository): IntakeInput {
  if (repo.getBindingBySession(input.sessionId)) return input;
  const sessionId = repo.projectMerges.redirectSession(input.sessionId);
  return sessionId ? { ...input, sessionId } : input;
}

export function createNeoIntakeOperation(
  db: Database,
  repo: NeoRepository,
  notify: NeoIntakeNotifier = noNotification,
  router?: NeoRouter
) {
  const store = new NeoAskTodoRepository(db.getDatabase());
  return defineOperation({
    name: 'neo.message.send',
    description:
      'Durably accept a human ask into an open Neo conversation without waiting for its coordinator. Supply a new requestId UUID per ask and reuse it only for retries of identical content. Acceptance does not mean the ask has been processed or answered. replyTo {kind, id} quotes a question, todo or message: a reply to a question or todo goes to the Neo session that owns its ask, a reply to a message goes to the session that wrote it, and a reply to a question is recorded as its answer. For each photo, thumbnails may carry a small preview { index, mediaType, data, width?, height? } keyed by the photo’s content index; it is stored for conversation pages and never sent to the model.',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'human_only' },
    execute: (input, caller) => runIntake(input, caller, db, repo, notify, router ?? null, store),
  });
}

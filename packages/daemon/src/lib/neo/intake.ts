import type { NeoPreviewReference } from '@hyperneo/shared/types/neo-preview-context';
import { NeoPreviewContextSchema, NeoPreviewReferenceSchema } from './preview-context-schema.ts';
import { admitNeoPreviewContext } from './preview-context.ts';
import { neoLocalTimeLine } from './local-time.ts';
import type { UUID } from 'node:crypto';
import type { Session } from '@hyperneo/shared';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import type { NeoAsk, NeoQuestion, NeoReplyTo, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import {
  neoChoiceByLetter,
  neoLabelledOptions,
  neoReplyExcerpt,
} from '@hyperneo/shared/types/neo-ask';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
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
import { NeoPublicationRepository } from '../../storage/repositories/neo-publication-repository.ts';
import { toMailboxMessage } from '../mailbox/entry.ts';
import { MessageSessionIdSchema, SessionContentSchema } from '../messaging/message-send.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { NeoReplyRefSchema } from './conversation-ask.ts';

const Input = z
  .object({
    sessionId: MessageSessionIdSchema,
    requestId: z.uuid(),
    content: SessionContentSchema,
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
    replyTo: NeoReplyRefSchema.optional(),
    previewContext: NeoPreviewContextSchema.optional(),
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
    previewContext: NeoPreviewReferenceSchema.optional(),
  }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
type IntakeInput = Omit<z.infer<typeof Input>, 'replyTo'> & { replyTo?: NeoReplyTo };
type IntakeResult = z.infer<typeof Result>;
type Gate<T> = { value: T } | { reason: Extract<IntakeResult, { ok: false }> };
type Target = Pick<Session, 'id' | 'status' | 'config'>;
type NeoIntakeNotifier = (sessionId: string, questionId?: string) => void;

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
  if (binding?.kind !== 'neo' || binding.sessionId !== input.sessionId)
    return { reason: { ok: false, reason: 'Open a Neo conversation before sending.' } };
  if (!session || session.id !== input.sessionId || session.status === 'archived')
    return { reason: { ok: false, reason: 'This Neo conversation is no longer available.' } };
  return { value: session };
}

export function neoIntakeMessage(
  input: IntakeInput,
  sessionId: string = input.sessionId,
  reply: NeoReply | null = null,
  localTime: string | null = null,
  stored?: SDKMessage,
  previewContext: NeoPreviewReference | null = null
): SDKUserMessage & {
  uuid: UUID;
  inputKind: 'human';
  replyTo?: NeoReplyTo;
  previewContext?: NeoPreviewReference;
  humanContent?: SDKUserMessage['message']['content'];
} {
  const content =
    typeof input.content === 'string'
      ? [{ type: 'text' as const, text: input.content }]
      : input.content;
  const fact =
    (reply?.ask?.sessionId === sessionId ? neoReplyFact(reply, neoAskText(input.content)) : null) ??
    neoQuoteFact(input.replyTo);
  const messageId = `[message id: ${input.requestId}]`;
  const first =
    stored?.type === 'user' && Array.isArray(stored.message.content)
      ? stored.message.content[0]
      : null;
  const identifier =
    !stored || (first?.type === 'text' && first.text === messageId) ? messageId : null;
  const previewFact = previewContext
    ? `Preview context: registered artifact ${previewContext.artifactId}, exact SHA-256 snapshot ${previewContext.snapshot}.`
    : null;
  const facts = [identifier, localTime, fact, previewFact].flatMap((text) =>
    text ? [{ type: 'text' as const, text }] : []
  );
  return {
    type: 'user',
    uuid: input.requestId as UUID,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: facts.length ? [...facts, ...content] : content,
    },
    inputKind: 'human',
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(previewContext ? { previewContext } : {}),
    ...(facts.length ? { humanContent: content } : {}),
  };
}

export function neoRetryLocalTime(stored: SDKMessage | undefined, fresh: string): string | null {
  if (!stored) return fresh;
  const content = stored.type === 'user' ? stored.message.content : null;
  const first = Array.isArray(content) ? content[0] : null;
  const time =
    first?.type === 'text' && first.text.startsWith('[message id: ')
      ? Array.isArray(content)
        ? content[1]
        : null
      : first;
  return time?.type === 'text' && time.text.startsWith('(local time: ') ? time.text : null;
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
  const askId = replyTo.kind === 'ask' ? replyTo.id : (question?.askId ?? todo?.askId);
  return { replyTo, question, todo, ask: askId ? store.getAsk(askId) : null };
}

export function neoReplyFact(reply: NeoReply | null, words = ''): string | null {
  const picked = neoChoiceByLetter(words, reply?.question ?? null);
  if (reply?.question && picked)
    return `The human answered your question "${reply.question.text}" with ${neoLabelledOptions(reply.question.options ?? [], picked)}:`;
  if (reply?.question?.kind === 'start')
    return `The human replied about your start question "${reply.question.text}" (it stays open; only its Start button starts todos):`;
  if (reply?.question) return `The human answered your question "${reply.question.text}":`;
  if (reply?.todo) return `The human replied about todo ${reply.todo.id}:`;
  return reply?.replyTo.kind === 'ask' && reply.ask
    ? `The human replied to the work card "${reply.ask.title}":`
    : null;
}

export function neoQuoteFact(replyTo: NeoReplyTo | undefined): string | null {
  if (replyTo?.kind !== 'message' || !replyTo.excerpt) return null;
  return replyTo.author === 'neo'
    ? `The human replied to the Neo message "${replyTo.excerpt}":`
    : `The human replied to their earlier message "${replyTo.excerpt}":`;
}

export function neoReplySnapshot(
  replyTo: NeoReplyTo | undefined,
  publication: NeoPublication | null,
  quoted: NeoConversationAsk | null,
  stored: NeoConversationAsk | null
): NeoReplyTo | undefined {
  if (replyTo?.kind !== 'message') return replyTo;
  if (stored) return stored.replyTo;
  const text = publication
    ? publication.shortText.trim() || publication.fullText.trim()
    : quoted
      ? neoAskText(quoted.content, '\n').trim() || '(attachment)'
      : '';
  const excerpt = neoReplyExcerpt(text);
  return {
    kind: replyTo.kind,
    id: replyTo.id,
    ...(publication ? { author: 'neo' as const } : quoted ? { author: 'user' as const } : {}),
    ...(excerpt ? { excerpt } : {}),
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
    reply.question.kind !== 'start' &&
    reply.ask?.sessionId === sessionId
  )
    store.answerQuestion(
      reply.question,
      neoChoiceByLetter(words, reply.question) ?? words,
      'chat',
      Date.now()
    );
  return receipt;
}

export function requireNeoIntakeConversation(conversation: string | null): Gate<string> {
  return conversation && z.uuid().safeParse(conversation).success
    ? { value: conversation }
    : { reason: { ok: false, reason: 'The public Neo conversation is no longer available.' } };
}

export function requireNeoRootTarget(
  admitted: IntakeTarget,
  root: NeoBinding | null,
  session: Target | null
): Gate<IntakeTarget> {
  return root && session?.id === root.sessionId && session.status !== 'archived'
    ? { value: { ...admitted, binding: root, target: session } }
    : { reason: { ok: false, reason: 'This Neo conversation is no longer available.' } };
}

async function persistNeoIntake(
  message: ReturnType<typeof neoIntakeMessage>,
  session: Target,
  db: Database,
  conversationId: string
): Promise<IntakeResult> {
  const receipt = await new NeoConversationAskRepository(db.getDatabase()).acceptPrompt(
    conversationId,
    message,
    session.config.queryMode === 'manual' ? 'manual' : 'immediate',
    db.getSDKMessageRepo(),
    db.getJobQueueRepo()
  );
  return receipt.accepted
    ? {
        ok: true,
        requestId: message.uuid,
        messageId: message.uuid,
        created: receipt.created,
        ...(receipt.ask.previewContext ? { previewContext: receipt.ask.previewContext } : {}),
      }
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

function neoAskText(content: IntakeInput['content'], separator = ' '): string {
  return typeof content === 'string'
    ? content
    : content
        .flatMap((block: { type: string; text?: string }) =>
          block.type === 'text' && block.text ? [block.text] : []
        )
        .join(separator);
}

function notifyNeoIntakeAcceptance(
  receipt: IntakeResult,
  notify: NeoIntakeNotifier,
  root: IntakeTarget,
  reply: NeoReply | null
): IntakeResult {
  if (receipt.ok) {
    try {
      if (reply?.question) notify(root.target.id, reply.question.id);
      else notify(root.target.id);
    } catch {}
  }
  return receipt;
}

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
  .pipe((repo: NeoRepository) => repo.conversationId(), 'repo', 'conversation')
  .pipe(requireNeoIntakeConversation, 'conversation', 'result:admission')
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
  .input(['input', 'caller', 'db', 'repo', 'notify', 'store'])
  .pipe(admitNeoIntake, ['input', 'caller'], 'result:receipt')
  .pipe(
    (input: IntakeInput, store: NeoAskTodoRepository) => readNeoReply(input.replyTo, store),
    ['input', 'store'],
    'reply'
  )
  .pipe(admitNeoIntakeTarget, ['input', 'db', 'repo'], 'result:receipt')
  .pipe(
    (input: IntakeInput, admitted: IntakeTarget, db: Database) =>
      input.replyTo?.kind === 'message'
        ? new NeoPublicationRepository(db.getDatabase()).get(
            admitted.conversationId,
            input.replyTo.id
          )
        : null,
    ['input', 'receipt', 'db'],
    'publication'
  )
  .pipe(
    (input: IntakeInput, admitted: IntakeTarget, db: Database) => {
      const asks = new NeoConversationAskRepository(db.getDatabase());
      return input.replyTo?.kind === 'message'
        ? {
            quoted: asks.find(admitted.conversationId, input.replyTo.id),
            stored: asks.find(admitted.conversationId, input.requestId),
          }
        : { quoted: null, stored: asks.find(admitted.conversationId, input.requestId) };
    },
    ['input', 'receipt', 'db'],
    'asks'
  )
  .pipe(
    (
      input: IntakeInput,
      publication: NeoPublication | null,
      asks: { quoted: NeoConversationAsk | null; stored: NeoConversationAsk | null }
    ): IntakeInput => {
      const replyTo = neoReplySnapshot(input.replyTo, publication, asks.quoted, asks.stored);
      return replyTo ? { ...input, replyTo } : input;
    },
    ['input', 'publication', 'asks'],
    'input'
  )
  .pipe(
    (admitted: IntakeTarget, repo: NeoRepository, db: Database) => {
      const root = repo.defaultBinding();
      return requireNeoRootTarget(admitted, root, root ? db.getSession(root.sessionId) : null);
    },
    ['receipt', 'repo', 'db'],
    'result:receipt'
  )
  .pipe((root: IntakeTarget) => root, 'receipt', 'root')
  .pipe(
    (
      input: IntakeInput,
      asks: { stored: NeoConversationAsk | null },
      db: Database,
      caller: OperationCaller
    ) =>
      admitNeoPreviewContext(
        input.previewContext,
        asks.stored?.previewContext,
        db.getDatabase(),
        caller
      ),
    ['input', 'asks', 'db', 'caller'],
    'result:receipt'
  )
  .pipe((context: NeoPreviewReference | null) => context, 'receipt', 'previewContext')
  .pipe(
    (
      input: IntakeInput,
      root: IntakeTarget,
      reply: NeoReply | null,
      db: Database,
      previewContext: NeoPreviewReference | null
    ) => {
      const stored = db
        .getSDKMessageRepo()
        .getStoredPromptsByUuid(root.target.id, input.requestId)[0];
      return neoIntakeMessage(
        input,
        root.target.id,
        reply,
        neoRetryLocalTime(
          stored,
          neoLocalTimeLine(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone)
        ),
        stored,
        previewContext
      );
    },
    ['input', 'root', 'reply', 'db', 'previewContext'],
    'message'
  )
  .pipe(
    (message: ReturnType<typeof neoIntakeMessage>, root: IntakeTarget, db: Database) =>
      persistNeoIntake(message, root.target, db, root.conversationId),
    ['message', 'root', 'db'],
    'receipt'
  )
  .pipe(
    (
      receipt: IntakeResult,
      reply: NeoReply | null,
      input: IntakeInput,
      store: NeoAskTodoRepository,
      root: IntakeTarget
    ) => recordNeoReplyAnswer(receipt, reply, input, store, root.target.id),
    ['receipt', 'reply', 'input', 'store', 'root'],
    'receipt'
  )
  .pipe(
    (receipt: IntakeResult, input: IntakeInput, root: IntakeTarget, db: Database) =>
      recordNeoIntakeImages(receipt, input, root.conversationId, db),
    ['receipt', 'input', 'root', 'db'],
    'receipt'
  )
  .pipe(notifyNeoIntakeAcceptance, ['receipt', 'notify', 'root', 'reply'], 'receipt')
  .endAsync('receipt') as (
  input: IntakeInput,
  caller: OperationCaller,
  db: Database,
  repo: NeoRepository,
  notify: NeoIntakeNotifier,
  store: NeoAskTodoRepository
) => Promise<IntakeResult>;

export function createNeoIntakeOperation(
  db: Database,
  repo: NeoRepository,
  notify: NeoIntakeNotifier = noNotification,
  store: NeoAskTodoRepository = new NeoAskTodoRepository(db.getDatabase())
) {
  return defineOperation({
    name: 'neo.message.send',
    description:
      'Durably accept a human ask into an open Neo conversation without waiting for its coordinator. Supply a new requestId UUID per ask and reuse it only for retries of identical content. Acceptance does not mean the ask has been processed or answered. replyTo {kind, id} quotes a question, todo, ask (work card) or message: every message and reply goes to the one Neo session, and a reply to a question is recorded as its answer, except a start question, where a reply is only a remark and the question stays open. For each photo, thumbnails may carry a small preview { index, mediaType, data, width?, height? } keyed by the photo’s content index; it is stored for conversation pages and never sent to the model.',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'human_only' },
    execute: (input, caller) => runIntake(input, caller, db, repo, notify, store),
  });
}

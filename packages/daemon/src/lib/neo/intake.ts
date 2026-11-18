import type { UUID } from 'node:crypto';
import { neoToolDescription } from '@hyperneo/prompts';
import type { Session } from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import type { NeoAsk, NeoQuestion, NeoReplyTo, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { neoChoiceByNumber, neoReplyExcerpt } from '@hyperneo/shared/types/neo-ask';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPreviewReference } from '@hyperneo/shared/types/neo-preview-context';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/database.ts';
import { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import {
  type NeoConversationAskImageRow,
  NeoConversationAskRepository,
} from '../../storage/repositories/neo-conversation-ask-repository.ts';
import { NeoPublicationRepository } from '../../storage/repositories/neo-publication-repository.ts';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { toMailboxMessage } from '../mailbox/entry.ts';
import { MessageSessionIdSchema, SessionContentSchema } from '../messaging/message-send.ts';
import { attribute, escapeSessionText } from '../messaging/session-envelope.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { voiceDiagnostic } from '../voice/diagnostics.ts';
import { snapshotNeoCardQuote } from './card-quote.ts';
import { NeoReplyRefSchema } from './conversation-ask.ts';
import { neoImageSize } from './image-size.ts';
import { neoLocalTimeLine } from './local-time.ts';
import { admitNeoPreviewContext } from './preview-context.ts';
import { NeoPreviewContextSchema, NeoPreviewReferenceSchema } from './preview-context-schema.ts';
import { isHumanWorkDecision } from './proposal.ts';
import { planNeoRemovedPrerequisiteAnswer } from './todo-removal.ts';

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
    speech: z.boolean().optional(),
    inputMode: z.enum(['text', 'dictation', 'live_voice']).optional(),
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
type IntakeInput = Omit<z.infer<typeof Input>, 'replyTo'> & {
  replyTo?: NeoReplyTo;
  retryOf?: string;
};
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

type StoredBlock = { type: string; text?: string };

export function readStoredEnvelope(
  blocks: readonly StoredBlock[] | null,
  requestId: string
): { enveloped: boolean; head: string | null } {
  const all = blocks ?? [];
  const last = all.at(-1);
  const open = new RegExp(`^\\s*<human-message id="${attribute(requestId)}"`);
  const openIndex = all.findIndex((block) => block.type === 'text' && open.test(block.text ?? ''));
  const closes = last?.type === 'text' && /^\s*<\/human-message>\s*$/.test(last.text ?? '');
  if (!closes || openIndex < 0 || openIndex > 1 || openIndex >= all.length - 1)
    return { enveloped: false, head: null };
  const before = all
    .slice(0, openIndex)
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();
  return { enveloped: true, head: before || null };
}

export function neoIntakeMessage(
  input: IntakeInput,
  sessionId: string = input.sessionId,
  reply: NeoReply | null = null,
  localTime: string | null = null,
  stored?: SDKMessage,
  previewContext: NeoPreviewReference | null = null,
  saidBlock: string | null = null
): SDKUserMessage & {
  uuid: UUID;
  inputKind: 'human';
  retryOf?: string;
  replyTo?: NeoReplyTo;
  previewContext?: NeoPreviewReference;
  humanContent?: SDKUserMessage['message']['content'];
} {
  const content =
    typeof input.content === 'string'
      ? [{ type: 'text' as const, text: input.content }]
      : input.content;
  const fact =
    (reply?.ask?.sessionId === sessionId ? neoReplyFact(reply) : null) ??
    neoQuoteFact(input.replyTo);
  const storedBlocks =
    stored?.type === 'user' && Array.isArray(stored.message.content)
      ? stored.message.content
      : null;
  const has = (text: string) =>
    storedBlocks?.some(
      (block: { type: string; text?: string }) =>
        block.type === 'text' && block.text?.startsWith(text) === true
    ) === true;
  const storedShape = readStoredEnvelope(storedBlocks, input.requestId);
  const enveloped = storedShape.enveloped;
  const legacy = stored !== undefined && !enveloped;
  const storedSaid = storedBlocks?.find(
    (block: { type: string; text?: string }) =>
      block.type === 'text' && block.text?.startsWith('<already-said>') === true
  );
  const said = saidBlock ?? (storedSaid?.type === 'text' ? (storedSaid.text ?? null) : null);
  const previewFact = previewContext
    ? `Preview context: registered artifact ${previewContext.artifactId}, exact SHA-256 snapshot ${previewContext.snapshot}.`
    : null;
  const sourceFact = input.inputMode ? `[input: ${input.inputMode}]` : null;
  const storedHumanContent = (stored as { humanContent?: unknown } | undefined)?.humanContent;
  if (legacy) {
    const facts = [
      has('(local time: ') ? null : localTime,
      has('Preview context: ') ? null : previewFact,
    ].filter((text): text is string => Boolean(text));
    return {
      type: 'user',
      uuid: input.requestId as UUID,
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          ...facts.map((text) => ({ type: 'text' as const, text })),
          ...(stored?.type === 'user' ? stored.message.content : content),
        ],
      },
      inputKind: 'human',
      ...(input.retryOf ? { retryOf: input.retryOf } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(previewContext ? { previewContext } : {}),
      ...(storedHumanContent !== undefined
        ? { humanContent: storedHumanContent as SDKUserMessage['message']['content'] }
        : facts.length
          ? { humanContent: content }
          : {}),
    };
  }
  const head =
    storedShape.head ??
    [said, [localTime, sourceFact].filter(Boolean).join(' '), previewFact]
      .filter(Boolean)
      .join('\n');
  const askId = reply?.question?.askId ?? reply?.ask?.id ?? null;
  const questionId = reply?.question?.id ?? null;
  const reference = [
    questionId ? ` question="${attribute(questionId)}"` : '',
    askId ? ` ask="${attribute(askId)}"` : '',
  ].join('');
  const envelope = [
    `id="${attribute(input.requestId)}"`,
    askId ? `ask="${attribute(askId)}"` : '',
    questionId ? `question="${attribute(questionId)}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const human = content.map((block) =>
    block.type === 'text' ? { ...block, text: escapeSessionText(block.text) } : block
  );
  return {
    type: 'user',
    uuid: input.requestId as UUID,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        ...(head ? [{ type: 'text' as const, text: `${head}\n` }] : []),
        {
          type: 'text' as const,
          text: `<human-message ${envelope}>\n${fact ? '' : '\n'}`,
        },
        ...(fact
          ? [
              {
                type: 'text' as const,
                text: `<reference${reference}>\n${escapeSessionText(fact)}\n</reference>\n\n`,
              },
            ]
          : []),
        ...human,
        { type: 'text' as const, text: '\n\n</human-message>' },
      ],
    },
    inputKind: 'human',
    ...(input.retryOf ? { retryOf: input.retryOf } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(previewContext ? { previewContext } : {}),
    humanContent: content,
  };
}

export function neoRetryLocalTime(stored: SDKMessage | undefined, fresh: string): string | null {
  if (!stored) return fresh;
  const content = stored.type === 'user' ? stored.message.content : null;
  if (!Array.isArray(content)) return null;
  const humanContent = (stored as { humanContent?: unknown }).humanContent;
  const words = Array.isArray(humanContent) ? humanContent.length : 0;
  const facts = words ? content.slice(0, -words) : content;
  for (const block of facts) {
    if (block.type !== 'text') continue;
    if (block.text.trimStart().startsWith('<human-message')) break;
    const line = block.text
      .split('\n')
      .find((candidate: string) => candidate.startsWith('(local time: '));
    const time = line?.match(/^\(local time: [^)]*\)/)?.[0];
    if (time) return time;
  }
  return null;
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

export function neoReplyFact(reply: NeoReply | null): string | null {
  if (reply?.question) return reply.question.text;
  if (reply?.todo) return reply.todo.title;
  return reply?.replyTo.kind === 'ask' && reply.ask ? reply.ask.title : null;
}

export function neoQuoteFact(replyTo: NeoReplyTo | undefined): string | null {
  if (replyTo?.kind !== 'message' || !replyTo.excerpt) return null;
  return replyTo.excerpt;
}

export function neoReplySnapshot(
  replyTo: NeoReplyTo | undefined,
  publication: NeoPublication | null,
  quoted: NeoConversationAsk | null,
  stored: NeoConversationAsk | null,
  reply: NeoReply | null = null
): NeoReplyTo | undefined {
  if (stored) return stored.replyTo;
  if (replyTo?.kind !== 'message')
    return (
      replyTo &&
      snapshotNeoCardQuote(
        replyTo,
        reply?.question?.text ?? reply?.todo?.title ?? reply?.ask?.title
      )
    );
  const text = publication
    ? publication.shortText?.trim() || publication.fullText.trim()
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
    !isHumanWorkDecision(reply.question) &&
    reply.ask?.sessionId === sessionId
  ) {
    const picked = neoChoiceByNumber(words, reply.question);
    if (picked === 'invalid') return receipt;
    const answer = picked ?? words;
    const now = Date.now();
    store.answerQuestion(
      reply.question,
      answer,
      'chat',
      now,
      { sessionId, messageId: input.requestId },
      undefined,
      planNeoRemovedPrerequisiteAnswer(
        reply.question,
        store.listFamilyTodos(reply.question.askId),
        answer,
        now
      )
    );
  }
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
  conversationId: string,
  liveVoice: boolean
): Promise<IntakeResult> {
  const receipt = await new NeoConversationAskRepository(db.getDatabase()).acceptPrompt(
    conversationId,
    message,
    session.config.queryMode === 'manual' ? 'manual' : 'immediate',
    db.getSDKMessageRepo(),
    db.getJobQueueRepo()
  );
  if (liveVoice && receipt.accepted && receipt.created)
    voiceDiagnostic('voice.input.accepted', {
      sessionId: session.id,
      messageId: message.uuid,
      atMs: Date.now(),
    });
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

const runIntake = (superpipe({})('neo.message.send') as PipelineAPI)
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
      asks: { quoted: NeoConversationAsk | null; stored: NeoConversationAsk | null },
      reply: NeoReply | null
    ): IntakeInput => {
      const replyTo = neoReplySnapshot(input.replyTo, publication, asks.quoted, asks.stored, reply);
      return replyTo ? { ...input, replyTo } : input;
    },
    ['input', 'publication', 'asks', 'reply'],
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
    (
      message: ReturnType<typeof neoIntakeMessage>,
      root: IntakeTarget,
      db: Database,
      input: IntakeInput
    ) =>
      persistNeoIntake(
        message,
        root.target,
        db,
        root.conversationId,
        input.inputMode === 'live_voice'
      ),
    ['message', 'root', 'db', 'input'],
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

export const retryNeoIntake = runIntake;

export function createNeoIntakeOperation(
  db: Database,
  repo: NeoRepository,
  notify: NeoIntakeNotifier = noNotification,
  store: NeoAskTodoRepository = new NeoAskTodoRepository(db.getDatabase())
) {
  return defineOperation({
    name: 'neo.message.send',
    description: neoToolDescription('neo.message.send'),
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'human_only' },
    execute: (input, caller) => runIntake(input, caller, db, repo, notify, store),
  });
}

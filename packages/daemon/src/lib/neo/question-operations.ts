import { neoDerivedId } from './derived-id.ts';
import { WorkerIdentitySchema } from '../drivers/worker-identity-schema.ts';
import { WorkRefSchema, type WorkRef } from '../drivers/types.ts';
import type { NeoQuestionSource } from '@hyperneo/shared/types/neo-ask';
import type {
  NeoAsk,
  NeoQuestion,
  NeoQuestionAnswer,
  NeoTodo,
} from '@hyperneo/shared/types/neo-ask';
import { neoLabelledOptions } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type {
  NeoAskTodoRepository,
  NeoQuestionDraft,
  NeoCardReplyContext,
} from '../../storage/repositories/neo-ask-todo-repository.ts';
import { requireLocalUser } from '../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { isVisibleHomeProposal, requireHomePath } from './home/save.ts';
import { requireNeoOpenAsk } from './todo-operations.ts';
import { ArtifactRefSchema, unregisteredArtifact } from '../artifacts/file-contracts.ts';
import type { ArtifactRefReader } from '../artifacts/read-operations.ts';
import type { LanguageSetting } from '@hyperneo/shared/types/settings';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';

const ReportLine = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\r\n]+$/);
const WorkerQuestion = z.strictObject({
  todoId: z.string().min(1),
  kind: z.enum(['question', 'blocked']),
  title: ReportLine,
  options: z.array(ReportLine).min(2).max(6),
  language: z.enum(['en', 'zh-Hans']),
  report: z
    .string()
    .min(1)
    .refine((text) => text.trim().length > 0),
});

export function createNeoWorkerQuestionWriter(
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  language: () => LanguageSetting | undefined,
  readSource: (ref: WorkRef) => Promise<NeoQuestionSource | null>,
  stored: (question: NeoQuestion) => void = () => {}
) {
  const write = (superpipe({})('neo.question.storeWorkerReport') as PipelineAPI)
    .input(['ref', 'raw'])
    .pipe(
      (raw: unknown) => {
        const parsed = WorkerQuestion.safeParse(raw);
        return parsed.success
          ? { value: parsed.data }
          : fail('invalid_report: use a short title and 2–6 short options.');
      },
      'raw',
      'result:outcome'
    )
    .pipe(
      (input: z.infer<typeof WorkerQuestion>) => {
        const configured = language();
        const expected =
          configured === 'system' || !configured
            ? Intl.DateTimeFormat().resolvedOptions().locale.startsWith('zh')
              ? 'zh-Hans'
              : 'en'
            : configured;
        return input.language === expected
          ? { value: input }
          : fail(`report_language: provide the card in ${expected}.`);
      },
      'outcome',
      'result:outcome'
    )
    .pipe(
      async (ref: WorkRef) => {
        const source = await readSource(ref);
        return source &&
          source.adapter === ref.adapter &&
          source.id === ref.id &&
          source.daemon === ref.daemon
          ? { value: source }
          : fail('source_session_unavailable: no readable reporting worker.');
      },
      'ref',
      'result:source'
    )
    .pipe(
      (input: z.infer<typeof WorkerQuestion>, ref: WorkRef, source: NeoQuestionSource) => {
        let rejection = 'report_assignment: choose a current todo assigned to this worker.';
        const question = store.writeCardReply(null, crypto.randomUUID(), () => {
          const todo = store.getTodo(input.todoId);
          const assigned = sessions.readRef(input.todoId);
          if (
            !todo ||
            !['doing', 'blocked'].includes(todo.state) ||
            !assigned ||
            assigned.adapter !== ref.adapter ||
            assigned.id !== ref.id ||
            assigned.daemon !== ref.daemon
          )
            return null;
          if (store.getAsk(todo.askId)?.status !== 'open') {
            rejection = 'ask_settled: this ask is no longer open.';
            return null;
          }
          const existing = store
            .listQuestions(todo.askId)
            .find((q) => q.todoId === todo.id && q.state === 'open');
          const card =
            existing ??
            store.askQuestion(
              crypto.randomUUID(),
              todo.askId,
              {
                text: input.title,
                kind: 'choice',
                options: input.options,
                multiple: false,
                noLabel: null,
                yesLabel: null,
                startTodos: null,
                todoId: todo.id,
                sourceSession: source,
                document: input.report,
              },
              Date.now()
            );
          store.updateTodo(
            todo,
            {
              state: 'blocked',
              blockedBy: 'needs-human',
              blockedReason: card.text,
              nextAction:
                input.language === 'zh-Hans' ? '等待人工答复。' : 'Waiting for a human answer.',
              report: input.report,
            },
            Date.now()
          );
          store.questionAnswers.bind(card.id, todo.id, source);
          stored(card);
          return card;
        });
        return question
          ? { ok: true as const, question }
          : { ok: false as const, reason: rejection };
      },
      ['outcome', 'ref', 'source'],
      'outcome'
    )
    .endAsync('outcome') as (ref: WorkRef, raw: unknown) => Promise<QuestionReceipt | Rejection>;
  return write;
}

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type QuestionReceipt = { ok: true; question: NeoQuestion };

const fail = (reason: string): { reason: Rejection } => ({ reason: { ok: false, reason } });

const Text = z.string().trim().min(1);

const Confirmation = z.object({
  path: z.string().min(1),
  sha256: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]+$/),
});
const Artifacts = z.array(ArtifactRefSchema).max(16).readonly().optional();
const Asked = {
  focused: z.boolean().optional(),
  sourceSession: WorkRefSchema.optional(),
  artifacts: Artifacts,
  todoId: Text.optional().describe(
    'One open question per todo. A distinct question returns todo_question_open; use replaces with the existing question id to change it explicitly.'
  ),
  askId: Text,
  text: Text,
  replyTo: z.array(z.uuid()).max(100).optional(),
  replaces: Text.optional(),
  confirm: Confirmation.optional(),
};

const Ask = z.discriminatedUnion('kind', [
  z.object({ ...Asked, kind: z.literal('yesno'), noLabel: Text, yesLabel: Text }),
  z.object({
    ...Asked,
    kind: z.literal('choice'),
    options: z.array(Text).min(2).max(6),
    multiple: z.boolean().default(false),
  }),
  z.object({ ...Asked, kind: z.literal('reply') }),
  z.object({
    askId: Text,
    text: Text,
    kind: z.literal('start'),
    sourceSession: Asked.sourceSession,
    focused: Asked.focused,
    artifacts: Artifacts,
    confirm: Confirmation.optional(),
    replyTo: Asked.replyTo,
  }),
]);

const Retire = z.object({ questionId: Text, reason: Text });

const Answer = z.object({ questionId: Text, answer: z.union([z.string(), z.array(z.string())]) });

const Get = z.object({ questionId: Text });

const AnswerDelivery = z.object({
  id: z.string(),
  questionId: z.string(),
  todoId: z.string(),
  sourceSession: WorkerIdentitySchema.extend({ provider: z.string(), link: z.string().nullable() }),
  answer: z.union([z.string(), z.array(z.string())]).nullable(),
  answeredBy: z.enum(['button', 'chat', 'rule']).nullable(),
  answeredAt: z.number().nullable(),
  receipt: z.string().nullable(),
  acceptedAt: z.number().nullable(),
  state: z.enum(['waiting', 'pending', 'accepted']),
});

export const NeoQuestionSchema = z.object({
  sourceSession: WorkerIdentitySchema.extend({
    provider: z.string(),
    link: z.string().nullable(),
  }).optional(),
  artifacts: Artifacts,
  todoId: z.string().nullable().optional(),
  document: z.string().nullable().optional(),
  replyTo: z.array(z.uuid()).optional(),
  id: z.string(),
  askId: z.string(),
  text: z.string(),
  kind: z.enum(['yesno', 'choice', 'reply', 'start']),
  options: z.array(z.string()).nullable(),
  multiple: z.boolean(),
  noLabel: z.string().nullable(),
  yesLabel: z.string().nullable(),
  startTodos: z.array(z.string()).nullable(),
  confirm: Confirmation.nullable().optional(),
  state: z.enum(['open', 'answered', 'retired']),
  answer: z.union([z.string(), z.array(z.string())]).nullable(),
  answeredBy: z.enum(['button', 'chat']).nullable(),
  answeredAt: z.number().nullable(),
  retiredReason: z.string().nullable(),
  replacedBy: z.string().nullable(),
  createdAt: z.number(),
});

const QuestionReadResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({
    ok: z.literal(true),
    question: NeoQuestionSchema.pick({
      id: true,
      text: true,
      kind: true,
      state: true,
      answer: true,
      answeredAt: true,
      confirm: true,
      document: true,
      replyTo: true,
      todoId: true,
      artifacts: true,
      sourceSession: true,
    }),
    answeredByHuman: z.boolean(),
    answerDelivery: z.array(AnswerDelivery).optional(),
  }),
]);

export function readNeoQuestion(question: NeoQuestion | null): z.infer<typeof QuestionReadResult> {
  if (!question) return { ok: false, reason: 'not_found: no such question.' };
  const {
    id,
    text,
    kind,
    state,
    answer,
    answeredAt,
    confirm,
    document,
    replyTo,
    todoId,
    artifacts,
    sourceSession,
  } = question;
  return {
    ok: true,
    question: {
      id,
      text,
      kind,
      state,
      answer,
      answeredAt,
      confirm,
      document,
      ...(artifacts ? { artifacts } : {}),
      ...(sourceSession ? { sourceSession } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(todoId ? { todoId } : {}),
    },
    answeredByHuman: state === 'answered',
  };
}

const QuestionResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({
    ok: z.literal(true),
    question: NeoQuestionSchema,
  }),
]);

type QuestionPlan = { ask: NeoAsk; draft: NeoQuestionDraft; reworded: NeoQuestion | null };

export function planNeoQuestion(
  ask: NeoAsk,
  questions: readonly NeoQuestion[],
  input: z.infer<typeof Ask>,
  todo?: NeoTodo | null,
  sourceSession?: NeoQuestionSource
): Gate<QuestionPlan> {
  if (input.focused && !sourceSession)
    return fail('source_session_unavailable: focused discussion needs one readable session.');
  const todoId = 'todoId' in input ? input.todoId : undefined;
  if (
    todoId &&
    (!todo ||
      todo.id !== todoId ||
      todo.askId !== ask.id ||
      ['done', 'removed'].includes(todo.state))
  )
    return fail('todo_closed: choose a current todo on this ask.');
  const confirm = input.confirm ?? null;
  if (confirm) {
    if (input.kind !== 'yesno')
      return fail('confirmation_kind: only yes/no questions bind a home proposal.');
    const path = requireHomePath(confirm);
    if (path.reason) return fail(path.reason.reason);
    if (!isVisibleHomeProposal(input.text, confirm))
      return fail('confirmation_body: show the exact home path and SHA-256 in the question text.');
  }
  const draft: NeoQuestionDraft = {
    text: input.text,
    ...(sourceSession ? { sourceSession } : {}),
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    ...(todoId ? { todoId } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    kind: input.kind,
    options: input.kind === 'choice' ? input.options : null,
    multiple: input.kind === 'choice' && input.multiple,
    noLabel: input.kind === 'yesno' ? input.noLabel : null,
    yesLabel: input.kind === 'yesno' ? input.yesLabel : null,
    startTodos: null,
    confirm,
  };
  if (input.kind !== 'start') return { value: { ask, draft, reworded: null } };
  const open = questions.find((question) => question.kind === 'start' && question.state === 'open');
  return open
    ? { value: { ask, draft: { ...draft, startTodos: open.startTodos }, reworded: open } }
    : fail(
        'no_start_question: no todo on this ask is waiting to start; add todos with an instruction and the daemon asks.'
      );
}

const START_QUESTION =
  "start_question: the daemon's start question carries the human's go-ahead; only the human answers it.";

export function requireNeoQuestionReplaceable(
  replaced: NeoQuestion | null,
  ask: NeoAsk,
  replaces: string | undefined
): Gate<NeoQuestion | null> {
  if (replaces === undefined) return { value: null };
  if (!replaced) return fail(`not_found: no question ${replaces}.`);
  if (replaced.askId !== ask.id)
    return fail(`other_ask: question ${replaces} belongs to another ask; replace only this ask's.`);
  if (replaced.kind === 'start') return fail(START_QUESTION);
  return replaced.state === 'open'
    ? { value: replaced }
    : fail(`question_closed: question ${replaces} is ${replaced.state}.`);
}

export function requireNeoOpenQuestion(question: NeoQuestion | null): Gate<NeoQuestion> {
  if (!question) return fail('not_found: no such question.');
  if (question.kind === 'start') return fail(START_QUESTION);
  return question.state === 'open'
    ? { value: question }
    : fail(`question_closed: this question is ${question.state}.`);
}

export function planNeoQuestionAnswer(
  question: NeoQuestion | null,
  answer: NeoQuestionAnswer
): Gate<{ question: NeoQuestion; answer: NeoQuestionAnswer }> {
  if (!question) return fail('not_found: no such question.');
  if (question.state !== 'open')
    return fail(`question_closed: this question is ${question.state}.`);
  const picked = [answer].flat();
  const allowed =
    question.kind === 'yesno'
      ? typeof answer === 'string' && (answer === 'no' || answer === 'yes')
      : question.kind === 'reply'
        ? typeof answer === 'string' && answer.trim().length > 0
        : picked.every((value) =>
            (question.kind === 'choice' ? question.options : question.startTodos)?.includes(value)
          ) &&
          (question.kind !== 'choice' || question.multiple || picked.length === 1);
  if (!allowed)
    return fail(`answer_invalid: that is not an answer to this ${question.kind} question.`);
  return {
    value: {
      question,
      answer: question.kind === 'choice' || question.kind === 'start' ? picked : answer,
    },
  };
}

export function requireNeoQuestionAnswered(written: {
  question: NeoQuestion | null;
  ask: NeoAsk | null;
}): Gate<{ question: NeoQuestion; ask: NeoAsk }> {
  return written.question && written.ask
    ? { value: { question: written.question, ask: written.ask } }
    : fail('question_closed: this question was answered already.');
}

export function neoQuestionAnsweredNote(question: NeoQuestion, todos: NeoTodo[]): string {
  const answer = question.answer ?? '';
  const said =
    question.kind === 'yesno'
      ? `${answer} (${answer === 'yes' ? question.yesLabel : question.noLabel})`
      : question.kind === 'start'
        ? `start ${
            [answer]
              .flat()
              .map((id) => todos.find((todo) => todo.id === id)?.title ?? id)
              .join(', ') || 'none'
          }`
        : neoLabelledOptions(question.options ?? [], [answer].flat()) || 'none';
  return `The human answered "${question.text}": ${said}.`;
}

export function createNeoQuestionOperations(
  store: NeoAskTodoRepository,
  told: (ask: NeoAsk, question: NeoQuestion, note: string) => Promise<void>,
  start: (todoId: string) => Promise<{ ok: boolean; reason?: string }>,
  receivedHumanInput: (caller: OperationCaller, messageId: string) => boolean = () => false,
  artifact: ArtifactRefReader = () => null,
  readSource: (ref: WorkRef) => Promise<NeoQuestionSource | null> = async () => null,
  replyContext: (
    caller: OperationCaller,
    ids: readonly string[] | undefined,
    askId: string
  ) => NeoCardReplyContext | null = () => null,
  publicationChanged: (conversationId: string) => void = () => {},
  deliverAnswers: (questionId: string) => Promise<void> = async () => {}
) {
  const ask = (superpipe({})('neo.question.ask') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Ask>, caller: OperationCaller) =>
        (input.replyTo ?? []).every((id) => receivedHumanInput(caller, id))
          ? { value: input }
          : fail('invalid_reply_to: cite only received human messages in this conversation.'),
      ['input', 'caller'],
      'result:outcome'
    )
    .pipe(
      (input: z.infer<typeof Ask>, caller: OperationCaller) => {
        const context = replyContext(caller, input.replyTo, input.askId);
        return {
          context,
          mutationId: context
            ? neoDerivedId(
                JSON.stringify([
                  'card-reply',
                  context.conversationId,
                  [...context.sourceMessageIds].sort(),
                  { ...input, replyTo: [...new Set(context.sourceMessageIds)].sort() },
                ])
              )
            : crypto.randomUUID(),
        };
      },
      ['input', 'caller'],
      'reply'
    )
    .pipe(
      (reply: { context: NeoCardReplyContext | null; mutationId: string }) => {
        const existing = reply.context
          ? store.cardReplyQuestion(reply.context.conversationId, reply.mutationId)
          : null;
        return existing ? { reason: { ok: true, question: existing } } : { value: null };
      },
      'reply',
      'result:outcome'
    )
    .pipe(
      (input: z.infer<typeof Ask>) => requireNeoOpenAsk(store.getAsk(input.askId)),
      'input',
      'result:outcome'
    )
    .pipe(
      (owned: NeoAsk, input: z.infer<typeof Ask>, caller: OperationCaller) => {
        const unknown = unregisteredArtifact(
          input.artifacts ?? [],
          (input.artifacts ?? []).map((ref) => artifact(ref.artifactId, caller))
        );
        return unknown
          ? fail(
              `invalid_artifact_reference: artifact "${unknown.artifactId}" is not one you can attach as given.`
            )
          : { value: owned };
      },
      ['outcome', 'input', 'caller'],
      'result:outcome'
    )
    .pipe(
      async (owned: NeoAsk, input: z.infer<typeof Ask>) => {
        const source = input.sourceSession ? await readSource(input.sourceSession) : undefined;
        if (input.sourceSession && !source)
          return fail('source_session_unavailable: choose one readable source session.');
        const current = requireNeoOpenAsk(store.getAsk(owned.id));
        if ('reason' in current) return current;
        return planNeoQuestion(
          current.value,
          store.listQuestions(owned.id),
          input,
          'todoId' in input && input.todoId ? store.getTodo(input.todoId) : null,
          source ?? undefined
        );
      },
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(
      (plan: QuestionPlan, reply: { context: NeoCardReplyContext | null; mutationId: string }) => {
        const existing = reply.context
          ? store.cardReplyQuestion(reply.context.conversationId, reply.mutationId)
          : null;
        return existing ? { reason: { ok: true, question: existing } } : { value: plan };
      },
      ['outcome', 'reply'],
      'result:outcome'
    )
    .pipe(
      (plan: QuestionPlan, input: z.infer<typeof Ask>) => {
        const replaces = input.kind === 'start' ? undefined : input.replaces;
        const replaced = requireNeoQuestionReplaceable(
          replaces ? store.getQuestion(replaces) : null,
          plan.ask,
          replaces
        );
        return 'reason' in replaced ? replaced : { value: { ...plan, replaced: replaced.value } };
      },
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(
      (
        plan: QuestionPlan & { replaced: NeoQuestion | null },
        reply: { context: NeoCardReplyContext | null; mutationId: string }
      ): QuestionReceipt | Rejection => {
        let reason = 'question_closed: the question to replace is no longer open.';
        const question = store.writeCardReply(reply.context, reply.mutationId, () => {
          const conflict =
            plan.draft.todoId &&
            store
              .listQuestions(plan.ask.id)
              .find(
                (q) =>
                  q.todoId === plan.draft.todoId && q.state === 'open' && q.id !== plan.replaced?.id
              );
          if (conflict) {
            reason = `todo_question_open: this todo already has open question ${conflict.id}; use replaces to change it explicitly.`;
            return null;
          }
          if (plan.reworded) {
            const { id, startTodos } = plan.reworded;
            store.extendStartQuestion(
              id,
              startTodos ?? [],
              plan.draft.text,
              Date.now(),
              plan.draft.replyTo,
              plan.draft.artifacts,
              plan.draft.sourceSession
            );
            const question = store.getQuestion(id);
            return question?.state === 'open' ? question : null;
          }
          const id = reply.mutationId;
          return plan.replaced
            ? store.replaceQuestion(plan.replaced, id, plan.draft, Date.now())
            : store.askQuestion(id, plan.ask.id, plan.draft, Date.now());
        });
        if (question && reply.context) publicationChanged(reply.context.conversationId);
        return question ? { ok: true, question } : { ok: false, reason };
      },
      ['outcome', 'reply'],
      'outcome'
    )
    .pipe(
      (result: QuestionReceipt | Rejection, input: z.infer<typeof Ask>) => {
        if (result.ok && input.focused && result.question.sourceSession)
          store.focusAsk(result.question.askId, result.question.sourceSession, Date.now());
        return result;
      },
      ['outcome', 'input'],
      'outcome'
    )
    .endAsync('outcome') as (
    input: z.infer<typeof Ask>,
    caller: OperationCaller
  ) => Promise<QuestionReceipt | Rejection>;

  const retire = (superpipe({})('neo.question.retire') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Retire>) =>
        requireNeoOpenQuestion(store.getQuestion(input.questionId)),
      'input',
      'result:outcome'
    )
    .pipe(
      (question: NeoQuestion): Gate<NeoQuestion> => {
        const open = requireNeoOpenAsk(store.getAsk(question.askId));
        return 'reason' in open ? open : { value: question };
      },
      'outcome',
      'result:outcome'
    )
    .pipe(
      (question: NeoQuestion, input: z.infer<typeof Retire>): QuestionReceipt | Rejection => {
        const retired = store.retireQuestion(question, input.reason, null, Date.now());
        return retired
          ? { ok: true, question: retired }
          : { ok: false, reason: 'question_closed: this question is no longer open.' };
      },
      ['outcome', 'input'],
      'outcome'
    )
    .end('outcome') as (
    input: z.infer<typeof Retire>,
    caller: OperationCaller
  ) => QuestionReceipt | Rejection;

  const answer = (superpipe({})('neo.question.answer') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(requireLocalUser, 'caller', 'result:outcome')
    .pipe(
      (input: z.infer<typeof Answer>) =>
        planNeoQuestionAnswer(store.getQuestion(input.questionId), input.answer),
      'input',
      'result:outcome'
    )
    .pipe(
      (plan: { question: NeoQuestion; answer: NeoQuestionAnswer }) => ({
        question: store.answerQuestion(plan.question, plan.answer, 'button', Date.now()),
        ask: store.getAsk(plan.question.askId),
      }),
      'outcome',
      'written'
    )
    .pipe(requireNeoQuestionAnswered, 'written', 'result:outcome')
    .pipe(
      async (answered: { question: NeoQuestion; ask: NeoAsk }): Promise<QuestionReceipt> => {
        const refused: string[] = [];
        if (answered.question.kind === 'start')
          for (const todoId of [answered.question.answer ?? []].flat()) {
            const started = await start(todoId);
            if (!started.ok)
              refused.push(`${store.getTodo(todoId)?.title ?? todoId}: ${started.reason}`);
          }
        await told(
          answered.ask,
          answered.question,
          [
            neoQuestionAnsweredNote(answered.question, store.listTodos(answered.ask.id)),
            ...(refused.length ? [`These did not start: ${refused.join(' ')}`] : []),
          ].join('\n')
        );
        await deliverAnswers(answered.question.id);
        return { ok: true, question: answered.question };
      },
      'outcome',
      'outcome'
    )
    .endAsync('outcome') as (
    input: z.infer<typeof Answer>,
    caller: OperationCaller
  ) => Promise<QuestionReceipt | Rejection>;

  return [
    defineOperation({
      name: 'neo.question.ask',
      description:
        'Ask the human one question on an open ask you own. When it derives from one worker output, pass sourceSession {adapter,id,daemon?} from that worker; omit it for mixed or absent sources. The card opens that session without changing the answer controls. For a prepared human-led focused discussion, also pass focused:true: retain its sourceSession on the ask after this card retires, and relay its turns as status only. Optional artifacts attaches up to 16 registered file references (daemonId, artifactId, title, kind, byteLength) returned by artifact.file.register or artifact.file.get; the card opens them in the existing preview. Keep the question short instead of pasting the document. For a question about one todo, pass its todoId; the card retires automatically when that todo is done, removed or gone. Optional replyTo cites received human message ids this question asks back about; it does not mark those inputs answered. Unknown, foreign, queued and non-human ids are refused. Format text as Markdown: short title line, a few bullets or a small table, bold key choice; no walls of text. A home proposal uses kind yesno with confirm:{path,sha256}; the question text must show that exact path and 64-character lowercase content hash alongside the proposed change. This records the proposal, not permission to save. kind yesno: noLabel (left, keep things as they are) and yesLabel (right, the change it names). choice: 2-6 options, multiple for pick-any; the card labels them A, B, C… in order and the human may answer by letter, so never put letters in the option text. Every card also has Reply in chat, where the human can answer in their own words, so never add an "other" or "something else" option. reply: answered in chat. start: rewords the start question the daemon opens on this ask for todos waiting to start; the human unticks any they do not want, and answering starts the ticked ones. It never opens a second one. Ask only what you cannot read yourself; never a bookkeeping question. replaces names an open question on the same ask: it is retired as replaced by this one in the same step. A successful question reply to a consumed human input automatically records one linked chat notice; do not publish a second notice. Options stay on the card and this does not mark the input answered.',
      inputSchema: Ask,
      resultSchema: QuestionResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => ask(input, caller),
    }),
    defineOperation({
      name: 'neo.question.retire',
      description:
        'Retire an open question on an ask you own when it no longer needs an answer, with the reason in one short sentence. It leaves the open questions and shows in Details as no longer needed.',
      inputSchema: Retire,
      resultSchema: QuestionResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => retire(input, caller),
    }),
    defineOperation({
      name: 'neo.question.get',
      description:
        "Read one of Neo's questions to the human by id: its text, state, answer and optional home path/hash binding. answeredByHuman is true only when the human answered it, by button or in their own chat; use it to check a decision another session reports.",
      inputSchema: Get,
      resultSchema: QuestionReadResult,
      policy: { safetyClass: 'read' },
      execute: async (input) => {
        const { question, answerDelivery } = store.questionAnswers.snapshot(input.questionId, () =>
          store.getQuestion(input.questionId)
        );
        return { ...readNeoQuestion(question), ...(question ? { answerDelivery } : {}) };
      },
    }),
    defineOperation({
      name: 'neo.question.answer',
      description:
        "The human's answer to an open question: no or yes, the chosen options, their words, or the todos to start. The answer goes to the ask's Neo session.",
      inputSchema: Answer,
      resultSchema: QuestionResult,
      policy: { safetyClass: 'human_only' },
      execute: async (input, caller) => answer(input, caller),
    }),
  ];
}

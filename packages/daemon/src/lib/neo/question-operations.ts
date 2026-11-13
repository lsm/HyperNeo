import { neoToolDescription } from '@hyperneo/prompts';
import { coreTodoPolicy } from './core-todo-checks.ts';
import { planNeoTodoDraft, type NeoTodoPolicy } from './todo-operations.ts';
import { neoTodoDependencyNodes, neoTodoReady } from './todo-dependencies.ts';
import { isNeoTodoStalledCard } from './todo-state.ts';
import { openHumanCard, replaceHumanCard, requireHumanCard } from './human-card.ts';
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
import { neoLabelledOptions, isAgentResolvedQuestion } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type {
  NeoAskTodoRepository,
  NeoQuestionDraft,
  NeoCardReplyContext,
} from '../../storage/repositories/neo-ask-todo-repository.ts';
import { requireLocalUser, isLocalUser } from '../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { isVisibleHomeProposal, requireHomePath } from './home/save.ts';
import { TodoCheck, requireNeoOpenAsk } from './todo-operations.ts';
import { noNeoInputReads, resolveNeoInputAsk, type NeoInputReads } from './input-ask.ts';
import { ArtifactRefSchema } from '../artifacts/file-contracts.ts';
import { readCardArtifactFacts, unverifiedCardArtifact } from './card-artifact-admission.ts';
import { PublicHandoffReference } from '../handoffs/outbox.ts';
import type { ArtifactRefReader } from '../artifacts/read-operations.ts';
import type { LanguageSetting } from '@hyperneo/shared/types/settings';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import type { StagedWorkerQuestion } from '../work-queue/follow-through.ts';
import { planNeoRemovedPrerequisiteAnswer } from './todo-removal.ts';

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

export const expectedReportLanguage = (configured: LanguageSetting | undefined) =>
  configured === 'system' || !configured
    ? Intl.DateTimeFormat().resolvedOptions().locale.startsWith('zh')
      ? 'zh-Hans'
      : 'en'
    : configured;

export function stageNeoWorkerQuestion(
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  ref: WorkRef,
  raw: unknown,
  language: LanguageSetting | undefined,
  staged: (todo: NeoTodo, question: StagedWorkerQuestion, reportId: string) => void
): { ok: true } | Rejection {
  const parsed = WorkerQuestion.safeParse(raw);
  if (!parsed.success)
    return { ok: false, reason: 'invalid_report: use a short title and 2–6 short options.' };
  const { todoId, ...question } = parsed.data;
  const expected = expectedReportLanguage(language);
  if (question.language !== expected)
    return { ok: false, reason: `report_language: provide the card in ${expected}.` };
  const now = Date.now();
  return store.inTransaction(() => {
    const todo = store.getTodo(todoId),
      assigned = sessions.readRef(todoId),
      dispatchId = sessions.inputs.list(todoId).at(-1)?.id ?? '';
    if (
      !todo ||
      store.getAsk(todo.askId)?.status !== 'open' ||
      !['doing', 'blocked'].includes(todo.state) ||
      assigned?.adapter !== ref.adapter ||
      assigned.id !== ref.id ||
      assigned.daemon !== ref.daemon
    )
      return {
        ok: false,
        reason: 'report_assignment: choose a current todo assigned to this worker.',
      };
    const blocked = store.updateTodo(
      todo,
      {
        state: 'blocked',
        blockedBy: 'needs-human',
        blockedReason: question.title,
        nextAction:
          question.language === 'zh-Hans'
            ? 'Neo 需要回复工人,或把问题转给人。'
            : 'Neo must answer the worker or relay the question to the human.',
        report: question.report,
      },
      now
    );
    const reportId = neoDerivedId(JSON.stringify([dispatchId, question.title, question.options]));
    sessions.recordNudge(todoId, {
      ...(sessions.readNudge(todoId) ?? { since: now, nudges: 0 }),
      blockerReport: {
        id: reportId,
        dispatchId,
        at: now,
        triagedAt: blocked.updatedAt,
      },
      workerQuestion: question,
    });
    staged(blocked, question, reportId);
    return { ok: true };
  });
}

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
        const expected = expectedReportLanguage(language());
        return input.language === expected
          ? { value: input }
          : fail(`report_language: provide the card in ${expected}.`);
      },
      'outcome',
      'result:outcome'
    )
    .pipe((input: z.infer<typeof WorkerQuestion>) => input, 'outcome', 'input')
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
      'result:outcome'
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
          const open = store
            .listQuestions(todo.askId)
            .find((q) => q.todoId === todo.id && q.state === 'open');
          const daemonCard = !!open && isNeoTodoStalledCard(open.text);
          if (open && daemonCard)
            store.retireQuestion(open, 'its worker asked its own question', null, Date.now());
          const existing = daemonCard ? null : open;
          const allowed = existing
            ? null
            : requireHumanCard(
                { text: input.title, kind: 'choice' as const },
                store.listQuestions(todo.askId),
                null,
                language()
              );
          if (allowed && 'reason' in allowed) {
            rejection = allowed.reason.reason;
            return null;
          }
          const card =
            existing ??
            openHumanCard(
              store,
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
      ['input', 'ref', 'outcome'],
      'outcome'
    )
    .endAsync('outcome') as (ref: WorkRef, raw: unknown) => Promise<QuestionReceipt | Rejection>;
  return write;
}

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type QuestionReceipt = { ok: true; question: NeoQuestion; records?: string[] };

const fail = (reason: string): { reason: Rejection } => ({ reason: { ok: false, reason } });

const Text = z.string().trim().min(1);

const Confirmation = z.object({
  path: z.string().min(1),
  sha256: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]+$/),
});
const Artifacts = z
  .array(z.union([ArtifactRefSchema, PublicHandoffReference]))
  .max(16)
  .readonly()
  .optional();
const QuestionOutputArtifacts = z
  .array(z.union([ArtifactRefSchema, PublicHandoffReference]))
  .max(16)
  .readonly()
  .optional();
const questionPolicies = () => [{ id: 'core', todos: coreTodoPolicy }];
const Asked = {
  retireWhen: TodoCheck.optional().describe(
    'Pack check that retires this card when satisfied. Defaults to the linked todo check; required without a linked todo check.'
  ),
  focused: z.boolean().optional(),
  sourceSession: WorkRefSchema.optional(),
  artifacts: Artifacts,
  document: Text.optional().describe('Full detail shown apart from the short card text.'),
  todoId: Text.optional().describe(
    'The todo this card belongs to. One card may be open per ask; a second returns card_open, and replaces changes the open one.'
  ),
  askId: Text.optional().describe(
    'For a human request, pass input. When a plain human message (not a reply) continues an open ask you own, also pass that askId: the daemon records the message on that ask, and later calls with that input alone reach it. Without askId it opens a new ask.'
  ),
  input: Text.optional().describe(
    'The [message id] of the human message this question serves. The daemon picks its ask: the question or Neo message it replied to, else the ask opened for it, else its recorded follow-up binding, else a new one.'
  ),
  text: Text,
  replyTo: z.array(z.uuid()).max(100).optional(),
  replaces: Text.optional(),
  confirm: Confirmation.optional(),
};

const AskKinds = z.discriminatedUnion('kind', [
  z.object({
    ...Asked,
    kind: z.literal('choice'),
    options: z.array(Text).min(1).max(6),
    multiple: z.boolean().default(false),
  }),
  z.object({ ...Asked, kind: z.literal('reply') }),
  z.object({
    askId: Text,
    text: Text,
    kind: z.literal('start'),
    retireWhen: Asked.retireWhen,
    sourceSession: Asked.sourceSession,
    focused: Asked.focused,
    artifacts: Artifacts,
    confirm: Confirmation.optional(),
    replyTo: Asked.replyTo,
  }),
]);
const Ask = AskKinds.refine((input) => input.askId || ('input' in input && input.input), {
  message: 'Pass input for a human request, or askId for follow-up work.',
}).refine((input) => ('todoId' in input && input.todoId) || input.retireWhen, {
  message: 'retireWhen is required without a linked todo; supply {pack, kind, params}.',
  path: ['retireWhen'],
});

type Bound = z.infer<typeof Ask> & { askId: string };

const Retire = z.object({ questionId: Text, reason: Text });
const Relay = z
  .object({
    todoId: Text.optional(),
    session: Text.optional().describe('The notice key of a session with no todo.'),
    title: ReportLine,
    options: z.array(ReportLine).min(2).max(6),
  })
  .refine((input) => !input.todoId !== !input.session, {
    message: 'Pass todoId, or session for a session with no todo.',
  });

const Answer = z.object({ questionId: Text, answer: z.union([z.string(), z.array(z.string())]) });
const Resolve = Answer.extend({
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('rule'), text: z.string().min(1) }),
    z.object({ kind: z.literal('answer'), questionId: Text }),
  ]),
});

const Get = z.object({
  questionId: z
    .string()
    .trim()
    .min(1)
    .meta({ aliases: ['id'] }),
});

const AnswerDelivery = z.object({
  id: z.string(),
  questionId: z.string(),
  todoId: z.string(),
  sourceSession: WorkerIdentitySchema.extend({ provider: z.string(), link: z.string().nullable() }),
  answer: z.union([z.string(), z.array(z.string())]).nullable(),
  answeredBy: z.enum(['button', 'chat', 'agent']).nullable(),
  answeredAt: z.number().nullable(),
  receipt: z.string().nullable(),
  acceptedAt: z.number().nullable(),
  state: z.enum(['waiting', 'pending', 'accepted']),
});

export const NeoQuestionSchema = z.object({
  retireWhen: TodoCheck.optional(),
  sourceSession: WorkerIdentitySchema.extend({
    provider: z.string(),
    link: z.string().nullable(),
  }).optional(),
  artifacts: QuestionOutputArtifacts,
  todoId: z.string().nullable().optional(),
  document: z.string().nullable().optional(),
  replyTo: z.array(z.uuid()).optional(),
  cause: z.string().nullable().optional(),
  id: z.string(),
  askId: z.string(),
  text: z.string(),
  kind: z.enum(['yesno', 'choice', 'reply', 'start']),
  options: z.array(z.string()).nullable(),
  multiple: z.boolean(),
  noLabel: z.string().nullable(),
  yesLabel: z.string().nullable(),
  startTodos: z.array(z.string()).nullable(),
  todos: z.array(z.string()),
  confirm: Confirmation.nullable().optional(),
  state: z.enum(['open', 'answered', 'retired']),
  answer: z.union([z.string(), z.array(z.string())]).nullable(),
  answerProvenance: z
    .object({
      words: z.string(),
      via: z.string(),
      viaName: z.string(),
      where: z.string(),
      when: z.string(),
      at: z.number(),
    })
    .optional(),
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
      answerProvenance: true,
      answeredAt: true,
      retiredReason: true,
      confirm: true,
      document: true,
      replyTo: true,
      todoId: true,
      artifacts: true,
      sourceSession: true,
      retireWhen: true,
    }),
    answeredByHuman: z.boolean(),
    resolvedByAgent: z.boolean(),
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
    answerProvenance,
    answeredAt,
    retiredReason,
    confirm,
    document,
    replyTo,
    todoId,
    artifacts,
    sourceSession,
    retireWhen,
  } = question;
  return {
    ok: true,
    question: {
      id,
      text,
      kind,
      state,
      answer,
      ...(answerProvenance ? { answerProvenance } : {}),
      answeredAt,
      retiredReason,
      confirm,
      document,
      ...(artifacts ? { artifacts } : {}),
      ...(sourceSession ? { sourceSession } : {}),
      ...(retireWhen ? { retireWhen } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(todoId ? { todoId } : {}),
    },
    answeredByHuman: state === 'answered',
    resolvedByAgent: isAgentResolvedQuestion(question),
  };
}

const QuestionResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({
    ok: z.literal(true),
    question: NeoQuestionSchema,
    records: z.array(z.string()).optional(),
  }),
]);

type QuestionPlan = {
  ask: NeoAsk;
  draft: NeoQuestionDraft;
  reworded: NeoQuestion | null;
  records?: string[];
};

export function planNeoQuestion(
  ask: NeoAsk,
  questions: readonly NeoQuestion[],
  input: z.infer<typeof Ask>,
  todo?: NeoTodo | null,
  sourceSession?: NeoQuestionSource,
  policies: readonly NeoTodoPolicy[] = questionPolicies()
): Gate<QuestionPlan> {
  if (input.focused && !sourceSession)
    return fail('source_session_unavailable: focused discussion needs one readable session.');
  const requestedTodoId = 'todoId' in input ? input.todoId : undefined;
  const todoId =
    requestedTodoId &&
    todo?.id === requestedTodoId &&
    todo.askId === ask.id &&
    !['done', 'closed_unverified', 'removed'].includes(todo.state)
      ? requestedTodoId
      : undefined;
  if (!input.retireWhen && (!todoId || !todo?.check))
    return fail(
      'retire_when_required: no linked todo check; supply retireWhen {pack, kind, params}.'
    );
  let checkRecords: string[] | undefined;
  if (input.retireWhen) {
    const checked = planNeoTodoDraft(
      { check: input.retireWhen, instruction: todoId ? todo!.instruction : null },
      policies
    );
    if ('reason' in checked) return checked;
    checkRecords = checked.value.records;
  }
  const records =
    requestedTodoId && !todoId
      ? {
          records: [
            ...(checkRecords ?? []),
            'todo_closed: the todo reference is not current; this question is recorded on the ask without linking that todo.',
          ],
        }
      : checkRecords
        ? { records: checkRecords }
        : {};
  const confirm = input.confirm ?? null;
  if (confirm) {
    if (input.kind !== 'choice' || input.multiple || input.options.length !== 1)
      return fail('confirmation_kind: only a one-option choice binds a home proposal.');
    const path = requireHomePath(confirm);
    if (path.reason) return fail(path.reason.reason);
    if (!isVisibleHomeProposal(input.text, confirm))
      return fail('confirmation_body: show the exact home path and SHA-256 in the question text.');
  }
  const draft: NeoQuestionDraft = {
    ...(input.retireWhen ? { retireWhen: input.retireWhen } : {}),
    text: input.text,
    ...(sourceSession ? { sourceSession } : {}),
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    ...('document' in input && input.document ? { document: input.document } : {}),
    ...(todoId ? { todoId } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    kind: input.kind,
    options: input.kind === 'choice' ? input.options : null,
    multiple: input.kind === 'choice' && input.multiple,
    noLabel: null,
    yesLabel: null,
    startTodos: null,
    confirm,
  };
  if (input.kind !== 'start') return { value: { ask, draft, reworded: null, ...records } };
  const open = questions.find((question) => question.kind === 'start' && question.state === 'open');
  return open
    ? {
        value: {
          ask,
          draft: { ...draft, startTodos: open.todos },
          reworded: open,
          ...records,
        },
      }
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
  return { value: replaced.state === 'open' ? replaced : null };
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
            (question.kind === 'choice' ? question.options : question.todos)?.includes(value)
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
  return isAgentResolvedQuestion(question)
    ? `Neo resolved "${question.text}": ${said}. ${question.retiredReason}`
    : `The human answered "${question.text}": ${said}.`;
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
  deliverAnswers: (questionId: string) => Promise<void> = async () => {},
  standingRules: () => readonly string[] = () => [],
  inputs: NeoInputReads = noNeoInputReads,
  policies: () => readonly NeoTodoPolicy[] = questionPolicies,
  relay: (
    input: z.infer<typeof Relay>,
    caller: OperationCaller
  ) => Promise<unknown> = async () => ({
    ok: false,
    reason: 'no_worker_question: this todo has no worker question to relay.',
  }),
  language: () => LanguageSetting | undefined = () => undefined
) {
  const ask = (superpipe({})('neo.question.ask') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Ask>, caller: OperationCaller) =>
        resolveNeoInputAsk(store, inputs, caller, input, input.text),
      ['input', 'caller'],
      'binding'
    )
    .pipe(
      (binding: Awaited<ReturnType<typeof resolveNeoInputAsk>>) =>
        'reason' in binding ? binding : { value: null },
      'binding',
      'result:outcome'
    )
    .pipe(
      (
        input: z.infer<typeof Ask>,
        caller: OperationCaller,
        binding: { value: { askId: string } }
      ) => ({
        ...input,
        askId: binding.value.askId,
        replyTo: input.replyTo?.filter((id) => receivedHumanInput(caller, id)),
      }),
      ['input', 'caller', 'binding'],
      'input'
    )
    .pipe(
      (input: Bound, caller: OperationCaller) => {
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
    .pipe((input: Bound) => requireNeoOpenAsk(store.getAsk(input.askId)), 'input', 'result:outcome')
    .pipe(
      (input: z.infer<typeof Ask>, caller: OperationCaller) =>
        readCardArtifactFacts(input.artifacts ?? [], caller, artifact),
      ['input', 'caller'],
      'artifactFacts'
    )
    .pipe(
      (
        owned: NeoAsk,
        input: z.infer<typeof Ask>,
        facts: Awaited<ReturnType<typeof readCardArtifactFacts>>
      ) => {
        const unknown = unverifiedCardArtifact(input.artifacts ?? [], facts);
        return unknown
          ? fail(
              `invalid_artifact_reference: artifact "${unknown.artifactId}" is not one you can attach as given.`
            )
          : { value: owned };
      },
      ['outcome', 'input', 'artifactFacts'],
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
          source ?? undefined,
          policies()
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
          const card =
            plan.draft.kind === 'start'
              ? null
              : requireHumanCard(
                  plan.draft,
                  store.listQuestions(plan.ask.id),
                  plan.replaced,
                  language()
                );
          if (card && 'reason' in card) {
            reason = card.reason.reason;
            return null;
          }
          if (plan.reworded) {
            const { id, todos } = plan.reworded;
            store.extendStartQuestion(
              id,
              todos,
              plan.draft.text,
              Date.now(),
              plan.draft.replyTo,
              plan.draft.artifacts,
              plan.draft.sourceSession,
              plan.draft.retireWhen
            );
            const question = store.getQuestion(id);
            return question?.state === 'open' ? question : null;
          }
          const id = reply.mutationId;
          return plan.replaced
            ? replaceHumanCard(store, plan.replaced, id, plan.draft, Date.now())
            : openHumanCard(store, id, plan.ask.id, plan.draft, Date.now());
        });
        if (question && reply.context) publicationChanged(reply.context.conversationId);
        return question
          ? { ok: true, question, ...(plan.records ? { records: plan.records } : {}) }
          : { ok: false, reason };
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
      (input: z.infer<typeof Retire>): Gate<NeoQuestion> => {
        const question = store.getQuestion(input.questionId);
        if (!question) return fail('not_found: no such question.');
        if (question.kind === 'start') return fail(START_QUESTION);
        return { value: question };
      },
      'input',
      'result:outcome'
    )
    .pipe(
      (question: NeoQuestion): Gate<NeoQuestion> | { reason: QuestionReceipt } => {
        if (question.state !== 'open') return { reason: { ok: true, question } };
        const open = requireNeoOpenAsk(store.getAsk(question.askId));
        return 'reason' in open ? open : { value: question };
      },
      'outcome',
      'result:outcome'
    )
    .pipe(
      (question: NeoQuestion): Gate<NeoQuestion> => {
        const todo = question.todoId ? store.getTodo(question.todoId) : null;
        return todo?.state === 'blocked' && todo.blockedBy === 'needs-human'
          ? fail(
              'todo_waiting: this card is what its todo waits on. Settle the todo first: neo.todo.remove when it is no longer needed, neo.todo.continue to send its worker on, or neo.question.ask with replaces to ask differently. Finished work needs nothing: its passing check closes both.'
            )
          : { value: question };
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

  const resolve = (superpipe({})('neo.question.resolve') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (
        input: z.infer<typeof Resolve>,
        caller: OperationCaller
      ): Gate<{ question: NeoQuestion; ask: NeoAsk }> => {
        let reason = 'question_closed: this question is no longer open.';
        const question = store.writeCardReply(null, crypto.randomUUID(), () => {
          const current = store.getQuestion(input.questionId);
          const ask = current && store.getAsk(current.askId);
          if (!current || !ask) {
            reason = 'not_found: no such question.';
            return null;
          }
          if (
            !isLocalUser(caller) &&
            (caller.role !== 'neo' || caller.sessionId !== ask.sessionId)
          ) {
            reason = 'not_owner: only this ask’s Neo or the user may resolve its worker card.';
            return null;
          }
          const open = requireNeoOpenAsk(ask);
          if ('reason' in open) {
            reason = open.reason.reason;
            return null;
          }
          if (
            !['choice', 'reply'].includes(current.kind) ||
            current.confirm ||
            !store.questionAnswers.list(current.id).length
          ) {
            reason =
              'worker_question_required: resolve only routed worker decisions, never approval cards.';
            return null;
          }
          const plan = planNeoQuestionAnswer(current, input.answer);
          if ('reason' in plan) {
            reason = plan.reason.reason;
            return null;
          }
          let citation: string;
          if (input.source.kind === 'rule') {
            if (!standingRules().includes(input.source.text)) {
              reason = 'rule_not_found: cite a currently saved standing rule.';
              return null;
            }
            citation = `Resolved by Neo from saved rule: ${input.source.text}`;
          } else {
            const prior = store.getQuestion(input.source.questionId);
            if (
              !prior ||
              prior.state !== 'answered' ||
              !['button', 'chat'].includes(prior.answeredBy ?? '') ||
              prior.answer === null ||
              store.getAsk(prior.askId)?.sessionId !== ask.sessionId
            ) {
              reason = 'human_answer_required: cite an earlier human answer owned by this Neo.';
              return null;
            }
            const title = prior.text.length > 200 ? `${prior.text.slice(0, 200)}…` : prior.text;
            citation = `Resolved by Neo from human answer "${title}" (${prior.id})`;
          }
          return store.resolveQuestion(current, plan.value.answer, citation, Date.now());
        });
        const ask = question && store.getAsk(question.askId);
        return question && ask ? { value: { question, ask } } : fail(reason);
      },
      ['input', 'caller'],
      'result:outcome'
    )
    .pipe(
      async ({
        question,
        ask,
      }: {
        question: NeoQuestion;
        ask: NeoAsk;
      }): Promise<QuestionReceipt> => {
        await told(ask, question, neoQuestionAnsweredNote(question, []));
        await deliverAnswers(question.id);
        return { ok: true, question };
      },
      'outcome',
      'outcome'
    )
    .endAsync('outcome') as (
    input: z.infer<typeof Resolve>,
    caller: OperationCaller
  ) => Promise<QuestionReceipt | Rejection>;

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
      (plan: { question: NeoQuestion }) => ({
        family: store.listFamilyTodos(plan.question.askId),
        now: Date.now(),
      }),
      'outcome',
      'facts'
    )
    .pipe(
      (
        plan: { question: NeoQuestion; answer: NeoQuestionAnswer },
        facts: { family: NeoTodo[]; now: number }
      ) => planNeoRemovedPrerequisiteAnswer(plan.question, facts.family, plan.answer, facts.now),
      ['outcome', 'facts'],
      'effects'
    )
    .pipe(
      (
        plan: { question: NeoQuestion; answer: NeoQuestionAnswer },
        facts: { now: number },
        effects: ReturnType<typeof planNeoRemovedPrerequisiteAnswer<NeoTodo>>
      ) => ({
        question: store.answerQuestion(
          plan.question,
          plan.answer,
          'button',
          facts.now,
          undefined,
          undefined,
          effects
        ),
        ask: store.getAsk(plan.question.askId),
      }),
      ['outcome', 'facts', 'effects'],
      'written'
    )
    .pipe(requireNeoQuestionAnswered, 'written', 'result:outcome')
    .pipe(
      async (answered: { question: NeoQuestion; ask: NeoAsk }): Promise<QuestionReceipt> => {
        const refused: string[] = [];
        const ticked =
          answered.question.kind === 'start' ? [answered.question.answer ?? []].flat() : [];
        const waiting = ticked.filter(
          (id) => !neoTodoReady(store.listFamilyTodos(answered.ask.id), id)
        );
        for (const todoId of ticked.filter((id) => !waiting.includes(id))) {
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
            ...(waiting.length
              ? [
                  `Waiting for earlier steps: ${waiting.map((id) => store.getTodo(id)?.title ?? id).join(', ')}.`,
                ]
              : []),
            ...waiting.flatMap((id) => {
              const family = store.listFamilyTodos(answered.ask.id);
              const held = (
                neoTodoDependencyNodes(family).find((node) => node.id === id)?.dependsOn ?? []
              )
                .map((dep) => family.find((todo) => todo.id === dep))
                .filter((todo) => todo?.blockedBy === 'held')
                .map((todo) => todo!.title);
              return held.length
                ? [
                    `${store.getTodo(id)?.title ?? id} waits for held steps: ${held.join(', ')}. Ask the human whether to release them (neo.todo.hold reason: null).`,
                  ]
                : [];
            }),
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
      name: 'neo.question.resolve',
      description: neoToolDescription('neo.question.resolve'),
      inputSchema: Resolve,
      resultSchema: QuestionResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: (input, caller) => resolve(input, caller),
    }),
    defineOperation({
      name: 'neo.question.ask',
      description: neoToolDescription('neo.question.ask'),
      inputSchema: Ask,
      resultSchema: QuestionResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => ask(input, caller),
    }),
    defineOperation({
      name: 'neo.question.retire',
      description: neoToolDescription('neo.question.retire'),
      inputSchema: Retire,
      resultSchema: QuestionResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => retire(input, caller),
    }),
    defineOperation({
      name: 'neo.question.relay',
      description: neoToolDescription('neo.question.relay'),
      inputSchema: Relay,
      resultSchema: QuestionResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => (await relay(input, caller)) as QuestionReceipt | Rejection,
    }),
    defineOperation({
      name: 'neo.question.get',
      description: neoToolDescription('neo.question.get'),
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
      description: neoToolDescription('neo.question.answer'),
      inputSchema: Answer,
      resultSchema: QuestionResult,
      policy: { safetyClass: 'human_only' },
      execute: async (input, caller) => answer(input, caller),
    }),
  ];
}

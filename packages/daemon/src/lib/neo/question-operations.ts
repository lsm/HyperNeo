import type {
  NeoAsk,
  NeoQuestion,
  NeoQuestionAnswer,
  NeoTodo,
} from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type {
  NeoAskTodoRepository,
  NeoQuestionDraft,
} from '../../storage/repositories/neo-ask-todo-repository.ts';
import { requireLocalUser } from '../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { requireNeoAskOwner } from './todo-operations.ts';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type QuestionReceipt = { ok: true; question: NeoQuestion };

const fail = (reason: string): { reason: Rejection } => ({ reason: { ok: false, reason } });

const Text = z.string().trim().min(1);

const Ask = z.discriminatedUnion('kind', [
  z.object({ askId: Text, kind: z.literal('yesno'), text: Text, noLabel: Text, yesLabel: Text }),
  z.object({
    askId: Text,
    kind: z.literal('choice'),
    text: Text,
    options: z.array(Text).min(2).max(6),
    multiple: z.boolean().default(false),
  }),
  z.object({ askId: Text, kind: z.literal('reply'), text: Text }),
  z.object({ askId: Text, kind: z.literal('start'), text: Text, todos: z.array(Text).min(1) }),
]);

const Answer = z.object({ questionId: Text, answer: z.union([z.string(), z.array(z.string())]) });

const QuestionResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({
    ok: z.literal(true),
    question: z.object({
      id: z.string(),
      askId: z.string(),
      text: z.string(),
      kind: z.enum(['yesno', 'choice', 'reply', 'start']),
      options: z.array(z.string()).nullable(),
      multiple: z.boolean(),
      noLabel: z.string().nullable(),
      yesLabel: z.string().nullable(),
      startTodos: z.array(z.string()).nullable(),
      state: z.enum(['open', 'answered', 'retired']),
      answer: z.union([z.string(), z.array(z.string())]).nullable(),
      answeredBy: z.enum(['button', 'chat']).nullable(),
      answeredAt: z.number().nullable(),
      createdAt: z.number(),
    }),
  }),
]);

export function planNeoQuestion(
  ask: NeoAsk,
  todos: NeoTodo[],
  input: z.infer<typeof Ask>
): Gate<{ ask: NeoAsk; draft: NeoQuestionDraft }> {
  const draft: NeoQuestionDraft = {
    text: input.text,
    kind: input.kind,
    options: input.kind === 'choice' ? input.options : null,
    multiple: input.kind === 'choice' && input.multiple,
    noLabel: input.kind === 'yesno' ? input.noLabel : null,
    yesLabel: input.kind === 'yesno' ? input.yesLabel : null,
    startTodos: input.kind === 'start' ? [...new Set(input.todos)] : null,
  };
  const unstartable = draft.startTodos?.filter(
    (id) => !todos.some((todo) => todo.id === id && todo.state === 'todo')
  );
  return unstartable?.length
    ? fail(`not_startable: ${unstartable.join(', ')} is not a not-started todo on this ask.`)
    : { value: { ask, draft } };
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
        : [answer].flat().join(', ') || 'none';
  return `The human answered "${question.text}": ${said}.`;
}

export function createNeoQuestionOperations(
  store: NeoAskTodoRepository,
  told: (ask: NeoAsk, question: NeoQuestion, note: string) => Promise<void>,
  start: (todoId: string) => Promise<unknown>
) {
  const ask = (superpipe({})('neo.question.ask') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Ask>, caller: OperationCaller) =>
        requireNeoAskOwner(store.getAsk(input.askId), caller),
      ['input', 'caller'],
      'result:outcome'
    )
    .pipe(
      (owned: NeoAsk, input: z.infer<typeof Ask>) =>
        planNeoQuestion(owned, store.listTodos(owned.id), input),
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(
      (plan: { ask: NeoAsk; draft: NeoQuestionDraft }): QuestionReceipt => ({
        ok: true,
        question: store.askQuestion(crypto.randomUUID(), plan.ask.id, plan.draft, Date.now()),
      }),
      'outcome',
      'outcome'
    )
    .end('outcome') as (
    input: z.infer<typeof Ask>,
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
        if (answered.question.kind === 'start')
          for (const todoId of [answered.question.answer ?? []].flat()) await start(todoId);
        await told(
          answered.ask,
          answered.question,
          neoQuestionAnsweredNote(answered.question, store.listTodos(answered.ask.id))
        );
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
        'Ask the human one question on an open ask you own. kind yesno: noLabel (left, keep things as they are) and yesLabel (right, the change it names). choice: 2-6 options, multiple for pick-any. reply: answered in chat. start: todos lists not-started todos; the human unticks any they do not want, and answering starts the ticked ones. Ask only what you cannot read yourself; never a bookkeeping question.',
      inputSchema: Ask,
      resultSchema: QuestionResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => ask(input, caller),
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

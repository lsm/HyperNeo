import type {
  NeoAsk,
  NeoAskEntry,
  NeoAskEntryState,
  NeoQuestion,
  NeoTodo,
  NeoTodoEntry,
} from '@hyperneo/shared/types/neo-ask';
import { neoOptionLabels } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { NeoPack } from './pack-contract.ts';
import { neoStartQuestionLine } from './start-question.ts';
import {
  NeoStatusCodesSchema,
  neoStatusLine,
  neoTextStatus,
  type NeoStatusLine,
} from './status-codes.ts';
import { NeoQuestionSchema } from './question-operations.ts';
import { NeoTodoSchema } from './todo-operations.ts';

const NEO_TODO_STATUS_EN = {
  'todo.replaced': 'Replaced by "{title}"',
  'todo.replaced.reason': 'Replaced by "{title}": {reason}',
  'todo.removed': 'Removed',
  'todo.failed': 'Not done',
  'todo.notStarted': 'Not started',
  'todo.doing': 'In progress',
  'todo.blocked': 'Blocked: {reason}',
  'todo.checking': 'Session reported; checking',
  'todo.awaitingNeo': 'Turn finished; waiting for Neo to check',
  'todo.reportedDone': 'Session says it is done',
  'todo.done': 'Done',
} as const;

const coded = (code: keyof typeof NEO_TODO_STATUS_EN, params: Record<string, string> = {}) =>
  neoStatusLine(NEO_TODO_STATUS_EN, [{ code, params }]);

export function neoTodoStatusLine(
  todo: NeoTodo,
  todos: readonly NeoTodo[],
  packLine: NeoStatusLine | null
): NeoStatusLine {
  if (todo.state === 'removed') {
    const title = todos.find((other) => other.id === todo.replacedBy)?.title;
    if (title)
      return todo.reason
        ? coded('todo.replaced.reason', { title, reason: todo.reason })
        : coded('todo.replaced', { title });
    return todo.reason ? neoTextStatus(todo.reason) : coded('todo.removed');
  }
  if (todo.state === 'failed')
    return todo.reason ? neoTextStatus(todo.reason) : coded('todo.failed');
  if (todo.state === 'blocked') return coded('todo.blocked', { reason: todo.blockedReason ?? '' });
  if (packLine) return packLine;
  if (todo.state === 'todo') return coded('todo.notStarted');
  if (todo.state === 'doing')
    return coded(!todo.report ? 'todo.doing' : todo.check ? 'todo.checking' : 'todo.awaitingNeo');
  if (todo.evidence) return neoTextStatus(todo.evidence);
  return coded(todo.report ? 'todo.reportedDone' : 'todo.done');
}

export function neoAskEntryState(
  ask: NeoAsk,
  todos: readonly NeoTodo[],
  questions: readonly NeoQuestion[]
): NeoAskEntryState {
  if (ask.status === 'dropped') return 'dropped';
  if (ask.status === 'done') return 'done';
  if (questions.some((question) => question.state === 'open')) return 'waiting';
  if (todos.some((todo) => todo.state === 'doing' || todo.state === 'blocked')) return 'doing';
  const live = todos.filter((todo) => todo.state !== 'removed');
  return live.length && live.every((todo) => todo.state === 'done') ? 'done' : 'todo';
}

export const NEO_DONE_TODOS_SHOWN = 3;

const NEO_TODO_LIST_ORDER: Record<NeoTodo['state'], number> = {
  blocked: 0,
  failed: 1,
  doing: 2,
  todo: 3,
  done: 4,
  removed: 5,
};

function neoTodoListOrder<T extends NeoTodo>(todos: readonly T[]): T[] {
  return [...todos].sort((a, b) => NEO_TODO_LIST_ORDER[a.state] - NEO_TODO_LIST_ORDER[b.state]);
}

export function neoSnapshotAskEntries(
  entries: readonly NeoAskEntry[],
  doneTodosShown = NEO_DONE_TODOS_SHOWN
): {
  todoAsks: NeoAskEntry[];
  pinned: string[];
} {
  return {
    todoAsks: entries.map((entry) =>
      entry.doneCount > doneTodosShown
        ? { ...entry, todos: entry.todos.filter((todo) => todo.state !== 'done') }
        : entry
    ),
    pinned: entries
      .filter((entry) => entry.ask.status === 'open')
      .flatMap((entry) => entry.todos.map((todo) => todo.id)),
  };
}

function projectNeoTodoEntries(
  shown: readonly NeoTodo[],
  todos: readonly NeoTodo[],
  links: ReturnType<NeoTodoSessionRepository['readLinksForTodos']>,
  packs: readonly NeoPack[]
): NeoTodoEntry[] {
  return shown.map((todo) => ({
    ...todo,
    ...neoTodoStatusLine(
      todo,
      todos,
      packs.find((pack) => pack.id === todo.check?.pack)?.todos?.statusLine(todo) ?? null
    ),
    ...(links.get(todo.id) ?? { link: null, remoteLink: null }),
  }));
}

export function projectNeoAskEntries(
  asks: readonly NeoAsk[],
  facts: ReturnType<NeoAskTodoRepository['snapshot']>['facts'],
  packs: readonly NeoPack[]
): NeoAskEntry[] {
  if (!asks.length) return [];
  const { todos: allTodos, questions: allQuestions, links } = facts;
  return asks.map((ask) => {
    const todos = allTodos.filter((todo) => todo.askId === ask.id);
    const questions = allQuestions.filter((question) => question.askId === ask.id);
    return {
      ask,
      state: neoAskEntryState(ask, todos, questions),
      todos: projectNeoTodoEntries(neoTodoListOrder(todos), todos, links, packs),
      doneCount: todos.filter((todo) => todo.state === 'done').length,
      questions: questions.map((question) => {
        if (question.kind === 'choice' && question.options)
          return { ...question, optionLabels: neoOptionLabels(question.options) };
        if (question.kind !== 'start' || !question.startTodos?.length) return question;
        const line = neoStartQuestionLine(
          question.startTodos.map((id) => ({ title: todos.find((todo) => todo.id === id)?.title }))
        );
        return line.status === question.text
          ? { ...question, textCodes: line.statusCodes }
          : question;
      }),
    };
  });
}

const Nullable = z.string().nullable();

const NeoTodoEntrySchema = NeoTodoSchema.extend({
  status: z.string(),
  statusCodes: NeoStatusCodesSchema,
  link: Nullable,
  remoteLink: Nullable,
});

export const NeoAskEntrySchema = z.object({
  ask: z.object({
    focusedSession: NeoQuestionSchema.shape.sourceSession,
    id: z.string(),
    goalId: Nullable.optional(),
    projectId: Nullable,
    repo: Nullable,
    parentId: Nullable,
    sessionId: z.string(),
    originMessageId: Nullable,
    title: z.string(),
    request: z.string(),
    status: z.enum(['open', 'done', 'dropped']),
    outcome: Nullable,
    createdAt: z.number(),
    updatedAt: z.number(),
    settledAt: z.number().nullable(),
  }),
  state: z.enum(['waiting', 'doing', 'done', 'dropped', 'todo']),
  todos: z.array(NeoTodoEntrySchema),
  doneCount: z.number(),
  questions: z.array(
    NeoQuestionSchema.extend({
      textCodes: NeoStatusCodesSchema,
      optionLabels: z.array(z.string()).optional(),
    })
  ),
});

const DoneTodos = z.object({
  askId: z.string().trim().min(1),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(20),
});

type Rejection = { ok: false; reason: string };
type DonePage = { ok: true; todos: NeoTodoEntry[]; doneCount: number; nextOffset: number | null };

export function requireNeoAskFound(ask: NeoAsk | null): { value: NeoAsk } | { reason: Rejection } {
  return ask ? { value: ask } : { reason: { ok: false, reason: 'not_found: no such ask.' } };
}

export function pageNeoDoneTodos(
  todos: readonly NeoTodo[],
  input: z.infer<typeof DoneTodos>
): { page: NeoTodo[]; doneCount: number; nextOffset: number | null } {
  const done = todos.filter((todo) => todo.state === 'done');
  const end = input.offset + input.limit;
  return {
    page: done.slice(input.offset, end),
    doneCount: done.length,
    nextOffset: end < done.length ? end : null,
  };
}

export function createNeoDoneTodosOperation(
  store: NeoAskTodoRepository,
  _sessions: NeoTodoSessionRepository,
  packs: () => readonly NeoPack[],
  admit: (caller: OperationCaller) => { value: OperationCaller } | { reason: Rejection },
  project: <T extends NeoTodo>(todos: readonly T[]) => Promise<T[]> = async (todos) => [...todos]
) {
  const read = (superpipe({})('neo.ask.doneTodos') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admit, 'caller', 'result:outcome')
    .pipe(
      (input: z.infer<typeof DoneTodos>) => store.read('doneTodoFacts', input.askId),
      'input',
      'facts'
    )
    .pipe(
      (facts: ReturnType<NeoAskTodoRepository['doneTodoFacts']>) => requireNeoAskFound(facts.ask),
      'facts',
      'result:outcome'
    )
    .pipe(
      (facts: ReturnType<NeoAskTodoRepository['doneTodoFacts']>) => facts.todos,
      'facts',
      'todos'
    )
    .pipe(pageNeoDoneTodos, ['todos', 'input'], 'paged')
    .pipe(
      (
        paged: ReturnType<typeof pageNeoDoneTodos>,
        todos: NeoTodo[],
        facts: ReturnType<NeoAskTodoRepository['doneTodoFacts']>
      ): DonePage => ({
        ok: true,
        todos: projectNeoTodoEntries(paged.page, todos, facts.links, packs()),
        doneCount: paged.doneCount,
        nextOffset: paged.nextOffset,
      }),
      ['paged', 'todos', 'facts'],
      'outcome'
    )
    .endAsync('outcome') as (
    input: z.infer<typeof DoneTodos>,
    caller: OperationCaller
  ) => Promise<DonePage | Rejection>;
  return defineOperation({
    name: 'neo.ask.doneTodos',
    description:
      'Read the done todos of an ask, a page at a time, in list order. An ask with more than 3 done todos (20 for RPC clients) lists none of them in neo.snapshot and carries only doneCount; read them here when you need to check finished work. Pass offset from nextOffset for the next page; nextOffset is null on the last page.',
    inputSchema: DoneTodos,
    resultSchema: z.union([
      z.object({ ok: z.literal(false), reason: z.string() }),
      z.object({
        ok: z.literal(true),
        todos: z.array(NeoTodoEntrySchema),
        doneCount: z.number(),
        nextOffset: z.number().nullable(),
      }),
    ]),
    policy: { safetyClass: 'read', roles: ['neo'] },
    execute: async (input, caller) => {
      const result = await read(input, caller);
      return result.ok ? { ...result, todos: await project(result.todos) } : result;
    },
  });
}

import type {
  NeoAsk,
  NeoAskEntry,
  NeoAskEntryState,
  NeoQuestion,
  NeoTodo,
} from '@hyperneo/shared/types/neo-ask';
import { z } from 'zod';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import type { NeoPack } from './packs/types.ts';
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

export function projectNeoAskEntries(
  asks: readonly NeoAsk[],
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  packs: readonly NeoPack[]
): NeoAskEntry[] {
  return asks.map((ask) => {
    const todos = store.listTodos(ask.id);
    const questions = store.listQuestions(ask.id);
    return {
      ask,
      state: neoAskEntryState(ask, todos, questions),
      todos: todos.map((todo) => ({
        ...todo,
        ...neoTodoStatusLine(
          todo,
          todos,
          packs.find((pack) => pack.id === todo.check?.pack)?.todos?.statusLine(todo) ?? null
        ),
        ...sessions.readLinks(todo.id),
      })),
      questions: questions.map((question) => {
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

export const NeoAskEntrySchema = z.object({
  ask: z.object({
    id: z.string(),
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
  todos: z.array(
    NeoTodoSchema.extend({
      status: z.string(),
      statusCodes: NeoStatusCodesSchema,
      link: Nullable,
      remoteLink: Nullable,
    })
  ),
  questions: z.array(NeoQuestionSchema.extend({ textCodes: NeoStatusCodesSchema })),
});

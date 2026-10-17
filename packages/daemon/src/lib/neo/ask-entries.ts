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
import { NeoQuestionSchema } from './question-operations.ts';
import { NeoTodoSchema } from './todo-operations.ts';

export function neoTodoStatusLine(
  todo: NeoTodo,
  todos: readonly NeoTodo[],
  packLine: string | null
): string {
  if (todo.state === 'removed') {
    const by = todos.find((other) => other.id === todo.replacedBy)?.title;
    return by ? `换成「${by}」${todo.reason ? `——${todo.reason}` : ''}` : (todo.reason ?? '删了');
  }
  if (todo.state === 'failed') return todo.reason ?? '没做成';
  if (packLine) return packLine;
  if (todo.state === 'todo') return '没开始';
  if (todo.state === 'doing') return todo.report ? '会话回报了，正在检查' : '在做';
  return todo.evidence ?? (todo.report ? '会话说做完了' : '做完了');
}

export function neoAskEntryState(
  ask: NeoAsk,
  todos: readonly NeoTodo[],
  questions: readonly NeoQuestion[]
): NeoAskEntryState {
  if (ask.status === 'dropped') return 'dropped';
  if (ask.status === 'done') return 'done';
  if (questions.some((question) => question.state === 'open')) return 'waiting';
  if (todos.some((todo) => todo.state === 'doing')) return 'doing';
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
        status: neoTodoStatusLine(
          todo,
          todos,
          packs.find((pack) => pack.id === todo.check?.pack)?.todos?.statusLine(todo) ?? null
        ),
        link: sessions.readLink(todo.id),
      })),
      questions,
    };
  });
}

const Nullable = z.string().nullable();

export const NeoAskEntrySchema = z.object({
  ask: z.object({
    id: z.string(),
    projectId: Nullable,
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
  todos: z.array(NeoTodoSchema.extend({ status: z.string(), link: Nullable })),
  questions: z.array(NeoQuestionSchema),
});

import superpipe, { type PipelineAPI } from 'superpipe';
import { workerIdentity } from '@hyperneo/shared/types/worker-identity';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import type { WorkRef } from '../drivers/types.ts';
import { neoDerivedId } from './derived-id.ts';
import { isNeoTodoStalledCard } from './todo-state.ts';

type Turn = { id: string; at: number; message: string };
type Blocker = { kind: 'needs-human' | 'environment'; reason: string };
export const recordWorkerBlocker = (superpipe({})('neo.worker-final-blocker') as PipelineAPI)
  .input(['store', 'sessions', 'expected', 'ref', 'dispatchId', 'turn', 'now'])
  .pipe(
    (turn: Turn): { value: Blocker } | { reason: null } => {
      const line =
        turn.message
          .replace(/\r?\n$/, '')
          .split(/\r?\n/)
          .at(-1) ?? '';
      const match = line.match(/^Blocked \((needs_human|environment)\): (.+)$/);
      return match?.[2].trim()
        ? {
            value: {
              kind: match[1] === 'needs_human' ? 'needs-human' : 'environment',
              reason: match[2].trim(),
            },
          }
        : { reason: null };
    },
    'turn',
    'result:blocker'
  )
  .pipe(
    (
      store: NeoAskTodoRepository,
      sessions: NeoTodoSessionRepository,
      expected: NeoTodo,
      ref: WorkRef,
      dispatchId: string,
      turn: Turn
    ) => {
      const todo = store.getTodo(expected.id),
        current = sessions.readRef(expected.id);
      const ask = todo && store.getAsk(todo.askId),
        input = sessions.inputs.list(expected.id).at(-1);
      const prior = sessions.readNudge(expected.id)?.blockerReport;
      const key = neoDerivedId(JSON.stringify([dispatchId, turn.id, turn.message]));
      const focused = ask?.focusedSession;
      return todo &&
        ask?.status === 'open' &&
        todo.updatedAt === expected.updatedAt &&
        ['doing', 'blocked'].includes(todo.state) &&
        todo.blockedBy !== 'held' &&
        current?.adapter === ref.adapter &&
        current.id === ref.id &&
        current.daemon === ref.daemon &&
        input?.id === dispatchId &&
        input.acceptedAt <= turn.at &&
        !(
          focused?.adapter === ref.adapter &&
          focused.id === ref.id &&
          focused.daemon === ref.daemon
        ) &&
        prior?.id !== key &&
        !(prior?.dispatchId === dispatchId && prior.at > turn.at)
        ? { value: { todo, key } }
        : { reason: null };
    },
    ['store', 'sessions', 'expected', 'ref', 'dispatchId', 'turn'],
    'result:scope'
  )
  .pipe(
    (
      store: NeoAskTodoRepository,
      sessions: NeoTodoSessionRepository,
      scope: { todo: NeoTodo; key: string },
      blocker: Blocker,
      ref: WorkRef,
      dispatchId: string,
      turn: Turn,
      now: number
    ) => {
      const { todo } = scope;
      if (blocker.kind === 'needs-human') {
        for (const question of store.listQuestions(todo.askId))
          if (
            question.todoId === todo.id &&
            question.state === 'open' &&
            isNeoTodoStalledCard(question.text)
          )
            store.retireQuestion(
              question,
              'its worker reported a blocker for Neo to triage',
              null,
              now
            );
      }
      const result = store.updateTodo(
        todo,
        {
          state: 'blocked',
          blockedBy: blocker.kind,
          blockedReason: blocker.reason,
          nextAction:
            blocker.kind === 'needs-human'
              ? 'Neo must answer the worker or ask the human with options.'
              : 'Resolve the environment failure, then retry or escalate.',
          report: turn.message,
        },
        now
      );
      sessions.recordNudge(todo.id, {
        ...(sessions.readNudge(todo.id) ?? { since: now, nudges: 0 }),
        blockerReport: {
          id: scope.key,
          dispatchId,
          at: turn.at,
          ...(blocker.kind === 'needs-human' ? { triagedAt: result.updatedAt } : {}),
        },
      });
      return result;
    },
    ['store', 'sessions', 'scope', 'blocker', 'ref', 'dispatchId', 'turn', 'now'],
    'result'
  )
  .end('result') as (
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  expected: NeoTodo,
  ref: WorkRef,
  dispatchId: string,
  turn: Turn,
  now: number
) => NeoTodo | null;

export const escalateWorkerBlocker = (superpipe({})('neo.worker-blocker-fallback') as PipelineAPI)
  .input(['store', 'sessions', 'todoId', 'now'])
  .pipe(
    (
      store: NeoAskTodoRepository,
      sessions: NeoTodoSessionRepository,
      todoId: string,
      now: number
    ) => {
      const todo = store.getTodo(todoId),
        prior = sessions.readNudge(todoId)?.blockerReport;
      const ref = sessions.readRef(todoId);
      return todo?.state === 'blocked' &&
        todo.blockedBy === 'needs-human' &&
        store.getAsk(todo.askId)?.status === 'open' &&
        prior?.triagedAt === todo.updatedAt &&
        now - prior.triagedAt >= 60 * 60_000 &&
        ref &&
        sessions.inputs.list(todoId).at(-1)?.id === prior.dispatchId &&
        !store
          .listQuestions(todo.askId)
          .some(
            (q) => q.state === 'open' && (q.todoId === todoId || q.startTodos?.includes(todoId))
          )
        ? { value: { todo, ref } }
        : { reason: null };
    },
    ['store', 'sessions', 'todoId', 'now'],
    'result:due'
  )
  .pipe(
    (store: NeoAskTodoRepository, due: { todo: NeoTodo; ref: WorkRef }, now: number) => {
      const { todo, ref } = due;
      const source = { ...workerIdentity(ref, null), provider: ref.adapter, link: null };
      const question = store.askQuestion(
        crypto.randomUUID(),
        todo.askId,
        {
          text: todo.blockedReason!,
          kind: 'reply',
          options: null,
          multiple: false,
          noLabel: null,
          yesLabel: null,
          startTodos: null,
          todoId: todo.id,
          document: todo.report,
          sourceSession: source,
        },
        now
      );
      store.questionAnswers.bind(question.id, todo.id, source);
      return question;
    },
    ['store', 'due', 'now'],
    'result'
  )
  .end('result') as (
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  todoId: string,
  now: number
) => unknown;

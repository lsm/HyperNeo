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
        const source = { ...workerIdentity(ref, null), provider: ref.adapter, link: null };
        let question = store
          .listQuestions(todo.askId)
          .find((q) => q.todoId === todo.id && q.state === 'open');
        if (question && isNeoTodoStalledCard(question.text)) {
          store.retireQuestion(question, 'its worker reported a human blocker', null, now);
          question = undefined;
        }
        question ??= store.askQuestion(
          crypto.randomUUID(),
          todo.askId,
          {
            text: blocker.reason,
            kind: 'reply',
            options: null,
            multiple: false,
            noLabel: null,
            yesLabel: null,
            startTodos: null,
            todoId: todo.id,
            document: turn.message,
            sourceSession: source,
          },
          now
        );
        store.questionAnswers.bind(question.id, todo.id, source);
      }
      const result = store.updateTodo(
        todo,
        {
          state: 'blocked',
          blockedBy: blocker.kind,
          blockedReason: blocker.reason,
          nextAction:
            blocker.kind === 'needs-human'
              ? 'Waiting for a human answer.'
              : 'Resolve the environment failure, then retry or escalate.',
          report: turn.message,
        },
        now
      );
      sessions.recordNudge(todo.id, {
        ...(sessions.readNudge(todo.id) ?? { since: now, nudges: 0 }),
        blockerReport: { id: scope.key, dispatchId, at: turn.at },
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

import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { planNeoTodoFailure } from '../../lib/neo/todo-runner.ts';
import type { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from './neo-todo-session-repository.ts';

type Recovery = { todo: NeoTodo; ask: NeoAsk };
type Facts = {
  todo: NeoTodo | null;
  ask: NeoAsk | null;
  ref: ReturnType<NeoTodoSessionRepository['readRef']>;
};

export const recoverNeoTodoStart = (superpipe({})('neo.todo.recover-start-state') as PipelineAPI)
  .input(['store', 'sessions', 'id', 'now'])
  .pipe(
    (store: NeoAskTodoRepository, sessions: NeoTodoSessionRepository, id: string): Facts => {
      const todo = store.getTodo(id);
      return { todo, ask: todo ? store.getAsk(todo.askId) : null, ref: sessions.readRef(id) };
    },
    ['store', 'sessions', 'id'],
    'facts'
  )
  .pipe(
    ({ todo, ask, ref }: Facts) =>
      todo?.state === 'doing' && ask && ref === null ? { value: { todo, ask } } : { reason: null },
    'facts',
    'result:recovery'
  )
  .pipe(
    (
      store: NeoAskTodoRepository,
      sessions: NeoTodoSessionRepository,
      plan: Recovery,
      now: number
    ): Recovery => {
      sessions.recordStartInterrupted(plan.todo.id);
      const receipt = store.commitState(
        plan.todo.id,
        planNeoTodoFailure(
          plan.todo,
          'Start was interrupted; a session may have started without being recorded.',
          now
        )!,
        now,
        { state: 'no_opinion' }
      );
      return { todo: receipt.todo!, ask: store.getAsk(plan.ask.id)! };
    },
    ['store', 'sessions', 'recovery', 'now'],
    'recovery'
  )
  .end('recovery') as (
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  id: string,
  now: number
) => Recovery | null;

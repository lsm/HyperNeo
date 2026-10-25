import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../drivers/types.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoTodoRunnerDeps } from './todo-runner.ts';
import { neoDerivedId } from './derived-id.ts';

type Live = { status: string; waitingFor?: string } | null;
type Turn = { message: string };
type Tell = NeoTodoRunnerDeps['tell'];

export const deliverNeoTurnReport = (superpipe({})('neo.deliver-turn-report') as PipelineAPI)
  .input(['ask', 'todo', 'dispatchId', 'ref', 'live', 'turn', 'tell'])
  .pipe(
    (ask: NeoAsk, todo: NeoTodo, dispatchId: string, ref: WorkRef, live: Live, turn: Turn) => {
      const focused = ask.focusedSession;
      const statusOnly =
        focused?.adapter === ref.adapter && focused.id === ref.id && focused.daemon === ref.daemon;
      const context = `todo ${todo.id}, dispatch ${dispatchId}, status ${live?.status ?? 'unknown'}`;
      const prefix = statusOnly
        ? `Focused discussion status only (ask ${ask.id}, ${context}). Do not act, reply, forward or treat this as approval.`
        : `Worker turn report (${context}):`;
      return [
        prefix,
        live?.waitingFor ? `Waiting for: ${live.waitingFor}` : '',
        turn.message || 'worker ended its turn with no reply',
      ]
        .filter(Boolean)
        .join('\n\n');
    },
    ['ask', 'todo', 'dispatchId', 'ref', 'live', 'turn'],
    'text'
  )
  .pipe(
    (todo: NeoTodo, dispatchId: string, ref: WorkRef, live: Live, turn: Turn, text: string) =>
      neoDerivedId(
        JSON.stringify([
          'neo-todo-turn',
          todo.id,
          dispatchId,
          ref.adapter,
          ref.id,
          ref.daemon ?? null,
          live?.status ?? null,
          live?.waitingFor ?? null,
          turn.message,
          text,
        ])
      ),
    ['todo', 'dispatchId', 'ref', 'live', 'turn', 'text'],
    'messageId'
  )
  .pipe(
    (ask: NeoAsk, todo: NeoTodo, text: string, messageId: string, tell: Tell) =>
      tell(ask, todo, text, messageId, 'event'),
    ['ask', 'todo', 'text', 'messageId', 'tell'],
    'delivered'
  )
  .endAsync('delivered') as (
  ask: NeoAsk,
  todo: NeoTodo,
  dispatchId: string,
  ref: WorkRef,
  live: Live,
  turn: Turn,
  tell: Tell
) => Promise<void>;

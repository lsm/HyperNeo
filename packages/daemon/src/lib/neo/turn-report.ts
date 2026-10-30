import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../drivers/types.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoTodoRunnerDeps } from './todo-runner.ts';
import type { NeoTurnReportReceipts } from './turn-report-receipts.ts';

type Live = { status: string; waitingFor?: string } | null;
type Turn = { id: string; at: number; startedAt?: number; senderMachine?: string; message: string };
type Tell = NeoTodoRunnerDeps['tell'];

export const deliverNeoTurnReport = (superpipe({})('neo.deliver-turn-report') as PipelineAPI)
  .input(['ask', 'todo', 'dispatchId', 'ref', 'currentLive', 'turn', 'tell', 'receipts'])
  .pipe(
    (
      todo: NeoTodo,
      dispatchId: string,
      ref: WorkRef,
      live: Live,
      turn: Turn,
      receipts: NeoTurnReportReceipts,
      ask: NeoAsk
    ) => receipts.observe(todo.id, dispatchId, ref, live, turn, ask.sessionId),
    ['todo', 'dispatchId', 'ref', 'currentLive', 'turn', 'receipts', 'ask'],
    'observation'
  )
  .pipe((observation: { live: Live }) => observation.live, ['observation'], 'live')
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
        !statusOnly && todo.blockedBy === 'needs-human'
          ? 'If you can answer this, reply to the worker and continue the todo; if only the human can decide, ask them with neo.question.ask (yesno or choice with options) linked to this todo.'
          : '',
      ]
        .filter(Boolean)
        .join('\n\n');
    },
    ['ask', 'todo', 'dispatchId', 'ref', 'live', 'turn'],
    'text'
  )
  .pipe(
    async (
      ask: NeoAsk,
      todo: NeoTodo,
      text: string,
      observation: { messageId: string; previousId: string; skip: boolean },
      tell: Tell,
      receipts: NeoTurnReportReceipts
    ) => {
      if (!observation.skip) {
        await tell(ask, todo, text, observation.messageId, 'event');
        receipts.acknowledge(observation.messageId);
      }
      receipts.acknowledge(observation.previousId);
    },
    ['ask', 'todo', 'text', 'observation', 'tell', 'receipts'],
    'delivered'
  )
  .endAsync('delivered') as (
  ask: NeoAsk,
  todo: NeoTodo,
  dispatchId: string,
  ref: WorkRef,
  live: Live,
  turn: Turn,
  tell: Tell,
  receipts: NeoTurnReportReceipts
) => Promise<void>;

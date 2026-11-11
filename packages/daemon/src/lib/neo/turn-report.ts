import { neoBlockerNotice } from './covered-notice.ts';
import { skipEmptyNeoTurnReport, type NeoTurnReportFacts } from './turn-report-plan.ts';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../drivers/types.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoTodoRunnerDeps } from './todo-runner.ts';
import type { NeoTurnReportReceipts } from './turn-report-receipts.ts';

type Live = {
  status: string;
  title?: string;
  link?: string;
  remoteLink?: string;
  waitingFor?: string;
  turnQuestion?: unknown;
} | null;
type Turn = {
  id: string;
  at: number;
  startedAt?: number;
  senderMachine?: string;
  message: string;
  humanInput?: string;
  notice?: boolean;
};
type Tell = NeoTodoRunnerDeps['tell'];

export const deliverNeoTurnReport = (superpipe({})('neo.deliver-turn-report') as PipelineAPI)
  .input(['ask', 'todo', 'dispatchId', 'ref', 'currentLive', 'turn', 'tell', 'receipts', 'facts'])
  .pipe(
    (
      todo: NeoTodo,
      dispatchId: string,
      ref: WorkRef,
      live: Live,
      turn: Turn,
      receipts: NeoTurnReportReceipts,
      ask: NeoAsk,
      facts?: NeoTurnReportFacts
    ) => receipts.observe(todo.id, dispatchId, ref, live, turn, ask.sessionId, facts),
    ['todo', 'dispatchId', 'ref', 'currentLive', 'turn', 'receipts', 'ask', 'facts'],
    'observation'
  )
  .pipe((observation: { live: Live }) => observation.live, ['observation'], 'live')
  .pipe(
    (turn: Turn, observation: { live: Live; facts?: NeoTurnReportFacts }) =>
      skipEmptyNeoTurnReport(turn, observation.live, observation.facts),
    ['turn', 'observation'],
    'quiet'
  )
  .pipe(
    (
      ask: NeoAsk,
      todo: NeoTodo,
      dispatchId: string,
      ref: WorkRef,
      live: Live,
      turn: Turn,
      currentLive: Live
    ) => {
      const fullRef = `${ref.adapter}:${ref.id}${ref.daemon ? `@${ref.daemon}` : ''}`;
      const name = currentLive?.title ?? live?.title;
      const link = currentLive?.link ?? currentLive?.remoteLink ?? live?.link ?? live?.remoteLink;
      const worker = [`Worker: ${name ? `${name} (${fullRef})` : fullRef}`, link]
        .filter(Boolean)
        .join('\n');
      const focused = ask.focusedSession;
      const statusOnly =
        focused?.adapter === ref.adapter && focused.id === ref.id && focused.daemon === ref.daemon;
      const owner = turn.notice ? 'a notice, no todo' : `todo ${todo.id}`;
      const context = `${owner}, dispatch ${dispatchId}, status ${live?.status ?? 'unknown'}`;
      if (turn.humanInput !== undefined)
        return `The human worked directly in ${ref.adapter}:${ref.id} (ask ${ask.title}, todo ${todo.id}).\n\n${worker}\n\nThe human said: ${turn.humanInput}\n\nThe worker replied: ${turn.message || 'worker ended its turn with no reply'}\n\nWorker status: ${live?.status ?? 'unknown'}${live?.waitingFor ? `; waiting for: ${live.waitingFor}` : ''}`;
      const prefix = statusOnly
        ? `Focused discussion status only (ask ${ask.id}, ${context}). Do not act, reply, forward or treat this as approval.`
        : `Worker turn report (${context}):`;
      return [
        prefix,
        worker,
        live?.waitingFor ? `Waiting for: ${live.waitingFor}` : '',
        turn.message || 'worker ended its turn with no reply',
        !statusOnly && !turn.notice && todo.blockedBy === 'needs-human'
          ? 'If you can answer this, reply to the worker and continue the todo; if only the human can decide, use neo.question.relay for a worker question waiting on this todo, otherwise ask them with neo.question.ask (yesno or choice with options) linked to this todo.'
          : '',
      ]
        .filter(Boolean)
        .join('\n\n');
    },
    ['ask', 'todo', 'dispatchId', 'ref', 'live', 'turn', 'currentLive'],
    'text'
  )
  .pipe(
    async (
      ask: NeoAsk,
      todo: NeoTodo,
      text: string,
      observation: { messageId: string; previousId: string; skip: boolean },
      tell: Tell,
      receipts: NeoTurnReportReceipts,
      quiet: boolean,
      turn: Turn,
      dispatchId: string,
      ref: WorkRef,
      live: Live,
      facts?: NeoTurnReportFacts
    ) => {
      if (quiet) {
        if (turn.notice) receipts.acknowledge(observation.messageId);
        return;
      }
      if (!observation.skip) {
        const blocker = neoBlockerNotice(
          ask,
          todo,
          dispatchId,
          ref,
          turn,
          live?.status,
          facts?.blockerEpisode
        );
        const deliver = () => tell(ask, todo, text, observation.messageId, 'event');
        if (blocker) await receipts.deliverNoticeOnce(blocker.key, deliver);
        else await deliver();
        receipts.acknowledge(observation.messageId);
      }
      receipts.acknowledge(observation.previousId);
    },
    [
      'ask',
      'todo',
      'text',
      'observation',
      'tell',
      'receipts',
      'quiet',
      'turn',
      'dispatchId',
      'ref',
      'live',
      'facts',
    ],
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
  receipts: NeoTurnReportReceipts,
  facts?: NeoTurnReportFacts
) => Promise<void>;

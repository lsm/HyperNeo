import { neoSafeSessionLink } from '../../storage/repositories/neo-todo-session-repository.ts';
import {
  isSilentNeoTurn,
  skipEmptyNeoTurnReport,
  type NeoTurnReportFacts,
} from './turn-report-plan.ts';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../drivers/types.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAttentionEvent } from './attention/decide.ts';
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
type Attend = (event: NeoAttentionEvent) => Promise<unknown>;
const fullRef = (ref: WorkRef) => `${ref.adapter}:${ref.id}${ref.daemon ? `@${ref.daemon}` : ''}`;

export const deliverNeoTurnReport = (superpipe({})('neo.deliver-turn-report') as PipelineAPI)
  .input([
    'ask',
    'todo',
    'dispatchId',
    'ref',
    'seen',
    'turn',
    'attend',
    'receipts',
    'facts',
    'latestAt',
  ])
  .pipe(
    (ask: NeoAsk, ref: WorkRef) => {
      const focused = ask.focusedSession;
      return (
        focused?.adapter === ref.adapter && focused.id === ref.id && focused.daemon === ref.daemon
      );
    },
    ['ask', 'ref'],
    'focus'
  )
  .pipe(
    (
      todo: NeoTodo,
      dispatchId: string,
      ref: WorkRef,
      live: Live,
      turn: Turn,
      receipts: NeoTurnReportReceipts,
      ask: NeoAsk,
      focus: boolean,
      facts?: NeoTurnReportFacts
    ) =>
      receipts.observe(
        turn.notice ? '' : todo.id,
        dispatchId,
        ref,
        live,
        turn,
        ask.sessionId,
        focus,
        facts
      ),
    ['todo', 'dispatchId', 'ref', 'seen', 'turn', 'receipts', 'ask', 'focus', 'facts'],
    'observation'
  )
  .pipe((observation: { live: Live }) => observation.live, ['observation'], 'live')
  .pipe(
    (turn: Turn, observation: { live: Live; facts?: NeoTurnReportFacts }) =>
      skipEmptyNeoTurnReport(turn, observation.live, observation.facts),
    ['turn', 'observation'],
    'quiet'
  )
  .pipe((observation: { focused: boolean }) => observation.focused, ['observation'], 'statusOnly')
  .pipe(
    (
      ask: NeoAsk,
      todo: NeoTodo,
      dispatchId: string,
      observation: { facts?: NeoTurnReportFacts },
      ref: WorkRef,
      live: Live,
      turn: Turn,
      statusOnly: boolean
    ) => {
      const name = (live?.title ?? '')
        .replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ')
        .trim()
        .slice(0, 200);
      const link =
        neoSafeSessionLink(live?.remoteLink, true) ?? neoSafeSessionLink(live?.link, !!ref.daemon);
      const worker = [`Worker: ${name ? `${name} (${fullRef(ref)})` : fullRef(ref)}`, link]
        .filter(Boolean)
        .join('\n');
      const owner = turn.notice ? 'a notice, no todo' : `todo ${todo.id}`;
      const context = `${owner}, dispatch ${dispatchId}, status ${live?.status ?? 'unknown'}`;
      const message = isSilentNeoTurn(turn.message) ? '' : turn.message;
      if (turn.humanInput !== undefined)
        return `The human worked directly in ${ref.adapter}:${ref.id} (ask ${ask.title}, todo ${todo.id}).\n\n${worker}\n\nThe human said: ${turn.humanInput}\n\nThe worker replied: ${message || 'worker ended its turn with no reply'}\n\nWorker status: ${live?.status ?? 'unknown'}${live?.waitingFor ? `; waiting for: ${live.waitingFor}` : ''}`;
      return [
        statusOnly
          ? `Focused discussion status only (ask ${ask.id}, ${context}). Do not act, reply, forward or treat this as approval.`
          : `Worker turn report (${context}):`,
        worker,
        live?.waitingFor ? `Waiting for: ${live.waitingFor}` : '',
        message || 'worker ended its turn with no reply',
        !statusOnly && !turn.notice && observation.facts?.blockedBy === 'needs-human'
          ? 'If you can answer this, reply to the worker and continue the todo; if only the human can decide, use neo.question.ask with kind relay for a worker question waiting on this todo, otherwise ask them with neo.question.ask (a choice with one option to confirm or several to choose, or a reply) linked to this todo.'
          : '',
      ]
        .filter(Boolean)
        .join('\n\n');
    },
    ['ask', 'todo', 'dispatchId', 'observation', 'ref', 'live', 'turn', 'statusOnly'],
    'text'
  )
  .pipe(
    async (
      todo: NeoTodo,
      text: string,
      observation: { sent: boolean },
      ref: WorkRef,
      attend: Attend,
      quiet: boolean,
      turn: Turn,
      live: Live,
      statusOnly: boolean,
      latestAt?: number
    ) => {
      if (quiet || observation.sent) return;
      await attend({
        kind: 'turn.report',
        subject: turn.notice ? { type: 'worker', id: fullRef(ref) } : { type: 'todo', id: todo.id },
        since: 0,
        facts: {
          text,
          latestAt: latestAt !== undefined && latestAt > turn.at ? latestAt : undefined,
          status: live?.status,
          question: !!live?.turnQuestion,
          todoState: turn.notice ? undefined : todo.state,
          focused: statusOnly,
        },
      });
    },
    [
      'todo',
      'text',
      'observation',
      'ref',
      'attend',
      'quiet',
      'turn',
      'live',
      'statusOnly',
      'latestAt',
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
  attend: Attend,
  receipts: NeoTurnReportReceipts,
  facts?: NeoTurnReportFacts,
  latestAt?: number
) => Promise<void>;

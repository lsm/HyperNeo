import { neoDerivedId } from '../derived-id.ts';
import type { NeoStepReason } from './owner.ts';

export type NeoAttentionEvent = {
  kind: string;
  subject: { type: string; id: string };
  since: number;
  facts: Record<string, unknown>;
};

export type NeoAttentionKnown = { covered: boolean; latestReportAt: number | null };

type Verdict = 'wake' | 'digest' | { drop: string };

export interface NeoAttentionKind {
  id: string;
  decide(event: NeoAttentionEvent, known: NeoAttentionKnown): Verdict;
  render(event: NeoAttentionEvent): string;
  sent?(event: NeoAttentionEvent): void;
  ladder?: readonly number[];
  every?: number;
  latestOnly?: true;
}

export type NeoAttentionDecision =
  | { value: { action: 'wake' | 'digest'; step: number } }
  | { reason: string };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const carried = (event: NeoAttentionEvent) => String(event.facts.text ?? '');
const always = (verdict: Verdict) => () => verdict;

const NEO_STEP: Record<NeoStepReason, (detail: string) => string> = {
  failed: (detail) =>
    `it failed${detail && `: ${detail}`}. Continue it with new direction, start a fresh worker, or remove it.`,
  prerequisite_gone: () =>
    'a prerequisite failed or was removed. Continue it without that step, replace the step, or remove it.',
  unanswered: () =>
    'it waits on an answer and no card is open. Answer its worker, or ask the human with neo.question.ask.',
  no_worker: () =>
    'its prerequisites are done and it has no instruction or worker. Write the instruction and start it, or remove it.',
  idle_worker: () =>
    'its worker is idle and nothing is pending. Continue it, mark it done, or remove it.',
};

export const NEO_ATTENTION_KINDS: readonly NeoAttentionKind[] = [
  {
    id: 'turn.report',
    latestOnly: true,
    render: carried,
    decide: ({ facts }) =>
      ['failed', 'needs_you'].includes(String(facts.status)) ||
      facts.question ||
      facts.blocked ||
      facts.todoState === 'blocked'
        ? 'wake'
        : facts.focused
          ? { drop: 'status only, focused' }
          : 'digest',
  },
  {
    id: 'todo.done',
    render: carried,
    decide: always({ drop: 'a finished todo is told with its ask' }),
  },
  { id: 'ask.finished', render: carried, decide: always('wake'), ladder: [DAY] },
  { id: 'todo.blocked', render: carried, decide: always('digest'), ladder: [4 * HOUR, DAY] },
  {
    id: 'todo.unworked',
    render: carried,
    ladder: [DAY],
    decide: ({ facts }) => (facts.reason === 'queue' ? { drop: 'daemon starts it' } : 'digest'),
  },
  {
    id: 'todo.neo_step',
    decide: always('wake'),
    ladder: [HOUR, 4 * HOUR, DAY],
    every: DAY,
    render: ({ subject, facts }) =>
      facts.reason === 'no_worker' && typeof facts.requestFrom === 'string'
        ? `Todo "${facts.title}" (${subject.id}) is a request from session ${facts.requestFrom} waiting for your answer. Answer it by closing this todo with neo.todo.done or neo.todo.remove and a reason; the daemon sends that reason to the requester.`
        : `Todo "${facts.title}" (${subject.id}) needs your next step: ${NEO_STEP[facts.reason as NeoStepReason](String(facts.detail ?? ''))}`,
  },
  { id: 'todo.stalled', render: carried, decide: always('wake'), ladder: [4 * HOUR] },
  { id: 'ask.idle', render: carried, decide: always('digest'), ladder: [DAY] },
  { id: 'worker.session_error', render: carried, decide: always('wake') },
  { id: 'request.reply_failed', render: carried, decide: always('wake') },
  { id: 'driver.health', render: carried, decide: always('digest'), ladder: [DAY] },
  {
    id: 'todo.follow_up_missing',
    decide: always('wake'),
    ladder: [HOUR, 4 * HOUR, DAY],
    render: ({ subject, facts }) =>
      `Todo "${facts.title}" (${facts.todoId}) in ask "${facts.askTitle}" (${subject.id}) finished and produces follow-up work, but no todo follows it. Add the follow-up todos it calls for with neo.todo.add after:["${facts.todoId}"]; the ask cannot settle done until one exists.`,
  },
];

function neoAttentionStep(kind: NeoAttentionKind, since: number, now: number): number {
  const age = now - since;
  const ladder = kind.ladder ?? [];
  const rungs = ladder.filter((rung) => age >= rung).length;
  const last = ladder.at(-1);
  return kind.every && last !== undefined && age >= last
    ? rungs + Math.floor((age - last) / kind.every)
    : rungs;
}

export function decideNeoAttention(
  event: NeoAttentionEvent,
  known: NeoAttentionKnown,
  now: number,
  kinds: readonly NeoAttentionKind[]
): NeoAttentionDecision {
  const kind = kinds.find((item) => item.id === event.kind);
  if (!kind) return { reason: `unknown kind ${event.kind}` };
  if (known.covered) return { reason: 'covered by card' };
  if (kind.latestOnly && (known.latestReportAt ?? 0) > event.since)
    return { reason: 'superseded by a newer report' };
  const verdict = kind.decide(event, known);
  return typeof verdict === 'string'
    ? { value: { action: verdict, step: neoAttentionStep(kind, event.since, now) } }
    : { reason: verdict.drop };
}

export function renderNeoAttention(
  event: NeoAttentionEvent,
  kinds: readonly NeoAttentionKind[]
): string {
  return kinds.find((item) => item.id === event.kind)?.render(event) ?? '';
}

export const neoAttentionUuid = (event: NeoAttentionEvent, step: number, text: string) =>
  neoDerivedId(
    JSON.stringify([
      'neo-attention',
      event.kind,
      event.subject.type,
      event.subject.id,
      event.since,
      step,
      text,
    ])
  );

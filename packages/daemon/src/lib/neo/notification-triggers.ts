import { fillPrompt, NEO_TRIGGER_NOTE } from '@hyperneo/prompts';
import { neoAskProgressNote } from './ask-progress.ts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type {
  NeoAsk,
  NeoAskHumanAction,
  NeoAskView,
  NeoCardView,
} from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { hashString32 } from '../runtime-hash.ts';
import { NEO_ASK_ANSWER_PREFIX } from './ask-origin.ts';
import { resumedPromptUuid } from '../agent/restart-turn-recovery.ts';

const NEO_HUMAN_CONTINUATIONS = ['neo-turn-limit:human:', NEO_ASK_ANSWER_PREFIX];

import { isNeoAskAnswerReady } from './answer-outcome.ts';
import { isNeoCardInPlay } from './ask-views.ts';

export const NEO_TRIGGER_PREFIX = 'neo-trigger:';
export const NEO_HUMAN_TRIGGER_PREFIX = 'human:';
export const NEO_TRIGGER_SWEEP_MS = 1_000;
export const NEO_TRIGGER_DELIVERY_RETRY_MS = 60_000;

export type NeoTriggerKind = 'outcome' | 'failed' | 'idle' | 'action';
export interface NeoTriggerKey {
  key: string;
  kind: NeoTriggerKind;
  line: string;
}
export interface NeoAskTrigger {
  triggerId: string;
  kind: NeoTriggerKind;
  keys: string[];
  lines: string[];
}
export interface NeoAskTriggerRead {
  view: NeoAskView;
  cards: readonly NeoCardView[];
}
type Card = Pick<NeoWork, 'id' | 'title' | 'updatedAt' | 'status'>;
type Rejection = { accepted: false; reason: string; detail: string };

export interface NeoTriggerSweepDeps {
  busy(ask: NeoAsk): boolean;
  read(ask: NeoAsk): NeoAskTriggerRead | null;
  work(id: string): Card | null;
  deliveryRetryPending(workId: string): boolean;
  reportSettled(workId: string, updatedAt: number): boolean;
  recorded(askId: string, triggerId: string): boolean;
  record(askId: string, keys: readonly string[], triggerId: string | null): void;
  wake(ask: NeoAsk, trigger: NeoAskTrigger): Promise<boolean>;
}

export function neoAskTriggerConcern(
  ask: Pick<NeoAsk, 'projectId'>,
  opener: { kind: string; projectId: string | null } | null
): string | null {
  return opener && opener.kind !== 'worker' ? opener.projectId : ask.projectId;
}

export function neoTriggerMessageId(triggerId: string): string {
  return `${NEO_TRIGGER_PREFIX}${triggerId}`;
}

export function neoHumanTrigger(messageId: string): string {
  return `${NEO_HUMAN_TRIGGER_PREFIX}${messageId}`;
}

export type NeoDeliveryTrigger = 'continues' | { readonly id: string } | null;

export function neoDeliveryTrigger(
  trigger: NeoDeliveryTrigger,
  parentTrigger: () => string | null
): string | null {
  if (trigger === 'continues') return parentTrigger();
  return trigger?.id ?? null;
}

export function neoHumanTriggerMessageId(triggerId: string | undefined): string | null {
  return triggerId?.startsWith(NEO_HUMAN_TRIGGER_PREFIX)
    ? triggerId.slice(NEO_HUMAN_TRIGGER_PREFIX.length) || null
    : null;
}

const TRIGGER_WORDS: Record<NeoTriggerKind, string> = {
  outcome: 'the ask reached its outcome',
  failed: 'a card failed with no retry left',
  idle: 'nothing is running for the ask and its outcome is not met',
  action: 'the ask needs the human',
};
export function neoTriggerNote(ask: NeoAsk, trigger: NeoAskTrigger): string {
  return neoAskProgressNote(
    ask,
    fillPrompt(NEO_TRIGGER_NOTE, {
      triggerId: trigger.triggerId,
      what: TRIGGER_WORDS[trigger.kind],
    }),
    { trigger: { id: trigger.triggerId, kind: trigger.kind, state: trigger.lines } }
  );
}

const titled = (card: Card | null, workId: string) => `card "${card?.title ?? workId}"`;

export function neoActionTriggerKey(action: NeoAskHumanAction): NeoTriggerKey {
  return {
    key: `question:${action.itemId}`,
    kind: 'action',
    line: `question: ${action.question}${action.options.length ? ` (options: ${action.options.join(' / ')})` : ' (reply in chat)'}`,
  };
}

export function isNeoCardFailedForGood(card: NeoCardView, pending: boolean): boolean {
  return (
    card.phase === 'failed' &&
    !card.superseded &&
    !card.retryable &&
    card.primary.kind !== 'retry' &&
    !pending
  );
}

export function neoAskIdleLine(ask: Pick<NeoAsk, 'refused' | 'refusedCount'>): string {
  const refused = ask.refused ? ` The last propose was refused: ${ask.refused}` : '';
  return `nothing is running for this ask and its outcome is not met.${refused}`;
}

export function neoAskOutcomeBase(ask: Pick<NeoAsk, 'doneItems'>): string {
  return `outcome:${(ask.doneItems ?? []).filter((item) => !item.removed).length}`;
}

export function neoAskOutcomeKey(ask: Pick<NeoAsk, 'doneItems'>): string {
  const open = (ask.doneItems ?? []).filter(
    (item) => !item.removed && item.state === 'needs_you'
  ).length;
  return `${neoAskOutcomeBase(ask)}${open ? `:q${open}` : ''}`;
}

export function planNeoSettledReports(
  cards: readonly Pick<NeoWork, 'id' | 'status' | 'updatedAt'>[],
  unprocessed: ReadonlySet<string>
): Map<string, number> {
  return new Map(
    cards
      .filter((card) => card.status === 'reported' && !unprocessed.has(card.id))
      .map((card) => [card.id, card.updatedAt])
  );
}

export function isNeoAskReportUnsettled(
  ask: Pick<NeoAsk, 'workIds'>,
  work: (id: string) => Card | null,
  settled: (workId: string, updatedAt: number) => boolean
): boolean {
  return ask.workIds.some((id) => {
    const card = work(id);
    return card?.status === 'reported' && !settled(card.id, card.updatedAt);
  });
}

export function neoAskTriggerKeys(
  ask: NeoAsk,
  read: NeoAskTriggerRead,
  work: (id: string) => Card | null,
  pending: (workId: string) => boolean,
  settled: (workId: string, updatedAt: number) => boolean
): NeoTriggerKey[] {
  const items = (ask.doneItems ?? []).filter((item) => !item.removed);
  const answer = isNeoAskAnswerReady(ask);
  const outcome =
    ask.status === 'achieved' ||
    answer ||
    (items.length > 0 && items.every((item) => item.state === 'met'));
  if (outcome)
    return [
      {
        key: neoAskOutcomeKey(ask),
        kind: 'outcome',
        line:
          ask.status === 'achieved'
            ? 'the ask is achieved'
            : answer
              ? 'the answer is ready'
              : 'every item of the ask is met',
      },
    ];
  if (ask.status === 'abandoned') return [];
  const live = read.cards.filter((card) => read.view.workIds.includes(card.workId));
  const failed = (live.some(isNeoCardInPlay) ? [] : live)
    .filter((card) => isNeoCardFailedForGood(card, pending(card.workId)))
    .map(
      (card): NeoTriggerKey => ({
        key: `failed:${card.workId}:${work(card.workId)?.updatedAt ?? 0}`,
        kind: 'failed',
        line: `${titled(work(card.workId), card.workId)} failed with no retry left`,
      })
    );
  const refused: NeoTriggerKey[] = live.flatMap((card) =>
    card.talk
      ? [
          {
            key: `refused:${card.workId}:${card.talk}`,
            kind: 'failed' as const,
            line: `${titled(work(card.workId), card.workId)} declined the instruction: ${card.talk}`,
          },
        ]
      : []
  );
  const idle: NeoTriggerKey[] =
    read.view.idle && !isNeoAskReportUnsettled(ask, work, settled)
      ? [
          {
            key: `idle:${Math.max(ask.createdAt, ...ask.workIds.map((id) => work(id)?.updatedAt ?? 0))}:${ask.refusedCount ?? 0}`,
            kind: 'idle',
            line: neoAskIdleLine(ask),
          },
        ]
      : [];
  return [
    ...failed,
    ...refused,
    ...idle,
    ...(read.view.humanActions ?? []).map(neoActionTriggerKey),
  ];
}

const KIND_ORDER: readonly NeoTriggerKind[] = ['outcome', 'failed', 'idle', 'action'];

export function planNeoAskTrigger(
  ask: Pick<NeoAsk, 'id' | 'revision'>,
  keys: readonly NeoTriggerKey[]
): { value: NeoAskTrigger } | { reason: null } {
  const fresh = keys;
  if (!fresh.length) return { reason: null };
  const kind = KIND_ORDER.find((kind) => fresh.some((key) => key.kind === kind)) ?? 'action';
  const signature = JSON.stringify({
    revision: ask.revision ?? 0,
    facts: fresh.map((key) => JSON.stringify([key.key, key.line])).sort(),
  });
  return {
    value: {
      triggerId: `${kind}:${ask.id}:${hashString32(signature).toString(36)}`,
      kind,
      keys: fresh.map((key) => key.key),
      lines: keys.map((key) => key.line),
    },
  };
}

export function neoTriggerWatchSessions(
  owner: string,
  works: readonly (Pick<NeoWork, 'status' | 'originSessionId'> | null)[]
): string[] {
  return [
    ...new Set([
      owner,
      ...works.flatMap((work) => (work?.status === 'proposed' ? [work.originSessionId] : [])),
    ]),
  ];
}

export function requireNeoTriggerOwnerIdle(
  ask: NeoAsk,
  deps: NeoTriggerSweepDeps
): { value: NeoAsk } | { reason: null } {
  return deps.busy(ask) ? { reason: null } : { value: ask };
}

export function requireNeoTriggerRead(
  ask: NeoAsk,
  deps: NeoTriggerSweepDeps
): { value: NeoAskTriggerRead } | { reason: null } {
  const read = deps.read(ask);
  return read ? { value: read } : { reason: null };
}

export function requireNeoTriggerUnrecorded(
  ask: NeoAsk,
  trigger: NeoAskTrigger,
  deps: NeoTriggerSweepDeps
): { value: NeoAskTrigger } | { reason: null } {
  return deps.recorded(ask.id, trigger.triggerId) ? { reason: null } : { value: trigger };
}

export function neoHumanTurnOrigin(
  messageId: string,
  trigger: string | null,
  isHumanInput: (messageId: string) => boolean
): string | null {
  messageId = resumedPromptUuid(messageId);
  if (isHumanInput(messageId)) return messageId;
  const human = neoHumanTriggerMessageId(trigger ?? undefined);
  return human &&
    NEO_HUMAN_CONTINUATIONS.some((prefix) => messageId.startsWith(prefix)) &&
    isHumanInput(human)
    ? human
    : null;
}

export function isNeoHumanOwnTurn(messageId: string, trigger: string | null): boolean {
  const human = neoHumanTriggerMessageId(trigger ?? undefined);
  return neoHumanTurnOrigin(messageId, trigger, (id) => id === human) !== null;
}

const readKeys = (ask: NeoAsk, read: NeoAskTriggerRead, deps: NeoTriggerSweepDeps) =>
  neoAskTriggerKeys(
    ask,
    read,
    (id) => deps.work(id),
    (id) => deps.deliveryRetryPending(id),
    (id, updatedAt) => deps.reportSettled(id, updatedAt)
  );

export const noteNeoAskTrigger = (superpipe({})('neo-ask-trigger') as PipelineAPI)
  .input(['ask', 'deps'])
  .pipe(requireNeoTriggerOwnerIdle, ['ask', 'deps'], 'result:owner')
  .pipe(requireNeoTriggerRead, ['owner', 'deps'], 'result:read')
  .pipe(readKeys, ['ask', 'read', 'deps'], 'keys')
  .pipe(planNeoAskTrigger, ['ask', 'keys'], 'result:trigger')
  .pipe(requireNeoTriggerUnrecorded, ['ask', 'trigger', 'deps'], 'result:trigger')
  .pipe(
    async (ask: NeoAsk, trigger: NeoAskTrigger, deps: NeoTriggerSweepDeps) => {
      if (!(await deps.wake(ask, trigger))) return null;
      deps.record(ask.id, trigger.keys, trigger.triggerId);
      return trigger;
    },
    ['ask', 'trigger', 'deps'],
    'trigger'
  )
  .endAsync('trigger') as (
  ask: NeoAsk,
  deps: NeoTriggerSweepDeps
) => Promise<NeoAskTrigger | null | undefined>;

export function requirePublicationTrigger<T>(
  value: T,
  draft: { triggerId?: string },
  trigger: string | null
): { value: T & { triggerId?: string } } | { reason: Rejection } {
  if (draft.triggerId && draft.triggerId !== trigger)
    return {
      reason: {
        accepted: false,
        reason: 'wrong_trigger',
        detail: trigger
          ? `This turn's trigger is ${trigger}, not ${draft.triggerId}. Publish with triggerId ${trigger}, or omit it.`
          : 'This turn has no trigger; omit triggerId.',
      },
    };
  return { value: { ...value, triggerId: trigger ?? undefined } };
}

import { fillPrompt, NEO_TRIGGER_NOTE } from '@hyperneo/prompts';
import { neoAskProgressNote } from './ask-progress.ts';
import type { NeoConsultation, NeoWork } from '@hyperneo/shared/types/neo-context';
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
import { isNeoCardInPlay, NEO_ASK_REFUSAL_BUDGET } from './ask-views.ts';

export const NEO_TRIGGER_PREFIX = 'neo-trigger:';
export const NEO_HUMAN_TRIGGER_PREFIX = 'human:';
export const NEO_TRIGGER_SWEEP_MS = 1_000;
export const NEO_TRIGGER_RETRY_MS = 60_000;
export const NEO_TRIGGER_ACHIEVED_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  told(askId: string): Set<string>;
  heard(ask: NeoAsk): boolean;
  record(askId: string, keys: readonly string[], triggerId: string | null): void;
  wake(ask: NeoAsk, trigger: NeoAskTrigger): Promise<boolean>;
}

export const NEO_TRIGGER_ATTEMPTS = 3;

export function neoAskTriggerConcern(
  ask: Pick<NeoAsk, 'projectId'>,
  opener: { kind: string; projectId: string | null } | null
): string | null {
  return opener && opener.kind !== 'worker' ? opener.projectId : ask.projectId;
}

export function neoTriggerMessageId(triggerId: string, attempt = 0): string {
  return `${NEO_TRIGGER_PREFIX}${triggerId}${attempt ? `#${attempt + 1}` : ''}`;
}

export function neoTriggerMessageIds(triggerId: string): string[] {
  return Array.from({ length: NEO_TRIGGER_ATTEMPTS }, (_, attempt) =>
    neoTriggerMessageId(triggerId, attempt)
  );
}

export type NeoTriggerRetry = 'retry' | 'wait' | 'done';

export function planNeoTriggerRetry(
  published: boolean,
  statuses: readonly string[]
): NeoTriggerRetry {
  if (published) return 'done';
  if (!statuses.length || statuses.some((status) => !TURN_OVER.has(status))) return 'wait';
  return statuses.length >= NEO_TRIGGER_ATTEMPTS ? 'done' : 'retry';
}

const TURN_OVER: ReadonlySet<string> = new Set(['consumed', 'failed']);

export function neoTriggerRetryStatuses(
  owner: readonly string[],
  legacy: readonly string[]
): readonly string[] {
  if (owner.length || !legacy.length) return owner;
  return legacy.every((status) => TURN_OVER.has(status)) ? ['consumed'] : ['pending'];
}

export function neoHumanTrigger(messageId: string): string {
  return `${NEO_HUMAN_TRIGGER_PREFIX}${messageId}`;
}

export type NeoDeliveryTrigger = 'continues' | { readonly id: string } | null;

export function neoConsultationDelivery(
  item: Pick<NeoConsultation, 'originMessageId'>
): NeoDeliveryTrigger {
  return item.originMessageId ? 'continues' : null;
}

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

export function neoActionTriggerKey(
  ask: Pick<NeoAsk, 'approvedAt'>,
  action: NeoAskHumanAction,
  work: (id: string) => Card | null
): NeoTriggerKey {
  const at = (id: string) => work(id)?.updatedAt ?? 0;
  const key = (key: string, line: string): NeoTriggerKey => ({ key, kind: 'action', line });
  switch (action.kind) {
    case 'start':
      return key(
        `start:${action.workId}`,
        `${titled(work(action.workId), action.workId)} waits for Start`
      );
    case 'retry':
      return key(
        `retry:${action.workId}:${at(action.workId)}`,
        `${titled(work(action.workId), action.workId)} failed and can be retried`
      );
    case 'close':
      return key(
        `close:${action.workId}`,
        `${titled(work(action.workId), action.workId)} can be closed`
      );
    case 'approve':
      return key(
        `approve:${action.reason}:${ask.approvedAt ?? 0}:${(action.workIds ?? []).join(',')}`,
        action.reason === 'expired'
          ? 'the ask’s approval expired and needs approving again'
          : 'a card stalled and the ask needs approving again'
      );
    case 'answer':
      return key(
        `answer:${action.itemId}`,
        `question: ${action.question} (options: ${action.options.join(' / ')})`
      );
    case 'confirm':
      return key(`confirm:${action.itemId}`, `step to confirm: ${action.step}`);
    case 'talk':
      return key(
        `talk:${action.workId}:${action.what}`,
        `${titled(work(action.workId), action.workId)} needs the human to tell it directly: ${action.what}`
      );
  }
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
  return (ask.refusedCount ?? 0) >= NEO_ASK_REFUSAL_BUDGET
    ? `nothing has started after ${ask.refusedCount} refused proposes.${refused} Ask the human one concrete question with neo.ask.question: where it is stuck (propose, start or which adapter), why in plain words, and the options you see.`
    : `nothing is running for this ask and its outcome is not met. Get the work moving another way (another adapter, place or approach).${refused}`;
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
              ? 'the answer is ready: publish it for this trigger and the daemon completes the ask'
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
    ...idle,
    ...(read.view.humanActions ?? [])
      .filter((action) => action.kind !== 'close')
      .map((action) => neoActionTriggerKey(ask, action, work)),
  ];
}

const KIND_ORDER: readonly NeoTriggerKind[] = ['outcome', 'failed', 'idle', 'action'];

export function planNeoAskTrigger(
  ask: Pick<NeoAsk, 'id'>,
  keys: readonly NeoTriggerKey[],
  told: ReadonlySet<string>
): { value: NeoAskTrigger } | { reason: null } {
  const fresh = keys.filter((key) => !told.has(key.key));
  if (!fresh.length) return { reason: null };
  const kind = KIND_ORDER.find((kind) => fresh.some((key) => key.kind === kind)) ?? 'action';
  const signature = fresh
    .map((key) => key.key)
    .sort()
    .join('|');
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

export function requireNeoTriggerUnheard(
  ask: NeoAsk,
  trigger: NeoAskTrigger,
  deps: Pick<NeoTriggerSweepDeps, 'heard' | 'record'>
): { value: NeoAskTrigger } | { reason: null } {
  if (trigger.kind !== 'outcome' || !deps.heard(ask)) return { value: trigger };
  deps.record(ask.id, trigger.keys, null);
  return { reason: null };
}

export function shouldPreemptNeoTurn(
  processingState: string | undefined,
  trigger: (messageId: string) => string | null,
  answered: (trigger: string) => boolean
): boolean {
  let state: { status?: unknown; messageId?: unknown } | null = null;
  try {
    state = processingState ? JSON.parse(processingState) : null;
  } catch {
    return false;
  }
  if (state?.status !== 'processing' || typeof state.messageId !== 'string') return false;
  const current = trigger(state.messageId);
  return !!current && (!current.startsWith(NEO_HUMAN_TRIGGER_PREFIX) || answered(current));
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

export function shouldRetryNeoTrigger(
  ask: Pick<NeoAsk, 'status'>,
  kind: string,
  heard: boolean
): boolean {
  if (kind === 'outcome') return !heard;
  return ask.status !== 'achieved' && ask.status !== 'abandoned';
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
  .pipe(
    (ask: NeoAsk, keys: NeoTriggerKey[], deps: NeoTriggerSweepDeps) =>
      planNeoAskTrigger(ask, keys, deps.told(ask.id)),
    ['ask', 'keys', 'deps'],
    'result:trigger'
  )
  .pipe(requireNeoTriggerUnheard, ['ask', 'trigger', 'deps'], 'result:trigger')
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

export const coverNeoAskTriggers = (superpipe({})('neo-ask-trigger-cover') as PipelineAPI)
  .input(['ask', 'deps', 'kinds'])
  .pipe(requireNeoTriggerRead, ['ask', 'deps'], 'result:read')
  .pipe(readKeys, ['ask', 'read', 'deps'], 'keys')
  .pipe(
    (
      ask: NeoAsk,
      keys: NeoTriggerKey[],
      kinds: readonly NeoTriggerKind[],
      deps: NeoTriggerSweepDeps
    ) => {
      const covered = keys.filter((key) => kinds.includes(key.kind)).map((key) => key.key);
      deps.record(ask.id, covered, null);
      return covered;
    },
    ['ask', 'keys', 'kinds', 'deps'],
    'covered'
  )
  .end('covered') as (
  ask: NeoAsk,
  deps: NeoTriggerSweepDeps,
  kinds: readonly NeoTriggerKind[]
) => string[] | null;

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

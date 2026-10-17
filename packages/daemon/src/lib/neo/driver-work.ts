import type { neoContinueFacts } from './card-wake.ts';
import {
  fillPrompt,
  NEO_WORK_BLOCKER,
  NEO_WORK_DONE_CHECK,
  NEO_WORK_DONE_CHECK_ASK_FOREIGN,
  NEO_WORK_DONE_CHECK_ASK_OWNED,
  NEO_WORK_GOAL,
  NEO_WORK_GOAL_ASKED,
  NEO_WORK_GOAL_DONE_WHEN,
  NEO_WORK_GOAL_MERGE,
  NEO_WORK_GOAL_PR_EVENTS,
  NEO_WORK_GOAL_PR_SUBSCRIBE,
  NEO_WORK_GOAL_REMAINING,
  NEO_WORK_NEEDS_YOU,
  NEO_WORK_PACK_NOTE,
  NEO_WORK_STALL,
  NEO_WORK_STUCK,
  NEO_WORK_STUCK_ABANDONED,
} from '@hyperneo/prompts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  type NeoAsk,
  type NeoWorkGoal,
  type NeoWorkPr,
  neoWorkPrVerdict,
} from '@hyperneo/shared/types/neo-snapshot';
import { z } from 'zod';
import { workStartConfiguration } from '../drivers/start-configuration.ts';
import {
  PlaceSchema,
  type WorkDelivery,
  WorkDeliverySchema,
  type WorkExchangeEntry,
  WorkExchangeEntrySchema,
  type WorkInput,
  WorkInputEvidenceSchema,
  WorkInputReceiptSchema,
  WorkInputSchema,
  type WorkRef,
  WorkRefSchema,
  type WorkStatus,
  WorkStatusSchema,
} from '../drivers/types.ts';
import { WORK_MESSAGE_MAX, WorkAdaptersResultSchema } from '../drivers/work-operations.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { hashString32 } from '../runtime-hash.ts';
import type { NeoPackCardFacts, NeoPackFragment } from './packs/types.ts';
import { neoAskProgressNote, neoNoteChecklist } from './ask-progress.ts';
import { NeoReadWorkTarget } from './read-work.ts';
import { awaitingNeoWorker } from './work-reroute.ts';

const NeoStartWorkTarget = z.object({
  verb: z.literal('start'),
  adapter: z.string().min(1).max(80),
  place: PlaceSchema,
  createFolder: z.boolean().optional(),
  preparationParameters: z
    .record(z.string(), z.json())
    .optional()
    .describe('Parameters for the linked ask pack preparation stage.'),
  ...workStartConfiguration.schema.shape,
});

const NeoSendWorkTarget = z.object({ verb: z.literal('send'), ref: WorkRefSchema });

export const NeoTodoTargetSchema = z.discriminatedUnion('verb', [
  NeoStartWorkTarget,
  NeoSendWorkTarget,
]);

export const NeoDriverTargetSchema = z.discriminatedUnion('verb', [
  NeoReadWorkTarget,
  NeoStartWorkTarget,
  NeoSendWorkTarget,
  z.object({ verb: z.literal('adopt'), ref: WorkRefSchema }),
]);

export type NeoDriverTarget = z.infer<typeof NeoDriverTargetSchema>;
type NeoDriverAdapter = { id: string; capabilities: readonly string[] };

export function driverTargetDaemon(target: NeoDriverTarget): string | undefined {
  return target.verb === 'read'
    ? undefined
    : target.verb === 'start'
      ? target.place.daemon
      : target.ref.daemon;
}

export async function readNeoDriverAdapters(
  invoke: () => Promise<OperationOutcome>
): Promise<NeoDriverAdapter[] | null> {
  try {
    const outcome = await invoke();
    const reply = WorkAdaptersResultSchema.safeParse(
      outcome.kind === 'completed' ? outcome.value : null
    );
    return reply.success && reply.data.ok ? reply.data.value : null;
  } catch {
    return null;
  }
}

export function readNeoStartFolder(
  target: NeoDriverTarget | null | undefined,
  exists: (folder: string) => boolean
): { exists: boolean | null } {
  return target?.verb === 'start' &&
    target.place.folder &&
    !target.place.daemon &&
    !target.createFolder
    ? { exists: exists(target.place.folder) }
    : { exists: null };
}

export function requireNeoStartFolder<T>(
  target: NeoDriverTarget | null | undefined,
  found: { exists: boolean | null },
  value: T
): { value: T } | { reason: { ok: false; reason: string } } {
  return target?.verb === 'start' && found.exists === false
    ? {
        reason: {
          ok: false,
          reason: `The folder ${target.place.folder} does not exist on ${target.place.machine}. Start work in a place from work.find, such as the repository's own checkout; the session makes its own worktree there. Never invent a folder.`,
        },
      }
    : { value };
}

export function requireNeoDriverVerb<T>(
  target: NeoDriverTarget | undefined,
  adapters: readonly NeoDriverAdapter[] | null,
  value: T
): { value: T } | { reason: { ok: false; reason: string } } {
  if (!target || target.verb === 'read' || !adapters) return { value };
  const id = target.verb === 'start' ? target.adapter : target.ref.adapter;
  const verb = target.verb === 'adopt' ? 'status' : target.verb;
  if (adapters.some((item) => item.id === id && item.capabilities.includes(verb))) return { value };
  const able = adapters.filter((item) => item.capabilities.includes(verb));
  return {
    reason: {
      ok: false,
      reason: `The ${id} adapter cannot ${target.verb} work. Adapters that can: ${able.map((item) => item.id).join(', ') || 'none'}.`,
    },
  };
}

const DriverReplySchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    value: z.union([z.object({ ref: WorkRefSchema }).passthrough(), WorkDeliverySchema]),
  }),
  z.object({ ok: z.literal(false), reason: z.string(), detail: z.string() }),
]);

export function neoWorkProgress(
  work: Pick<NeoWork, 'status' | 'report'>,
  prRevision: number | null,
  prior: string | null
): string {
  const report =
    work.status === 'reported'
      ? hashString32(work.report ?? '').toString(36)
      : (prior?.split('|')[1] ?? '-');
  return `${prRevision ?? 0}|${report}`;
}

export function withWorkGoal(
  instruction: string,
  goal: NeoWorkGoal | null,
  eventsDelivered = true
): string {
  if (!goal?.goal && !goal?.doneWhen) return withTail(instruction, ['', NEO_WORK_BLOCKER]);
  return withTail(instruction, [
    '',
    NEO_WORK_GOAL,
    ...(goal.goal ? [fillPrompt(NEO_WORK_GOAL_ASKED, { goal: goal.goal })] : []),
    ...(goal.doneWhen ? [fillPrompt(NEO_WORK_GOAL_DONE_WHEN, { done_when: goal.doneWhen })] : []),
    ...(/merg/i.test(goal.doneWhen ?? '')
      ? [
          NEO_WORK_GOAL_MERGE,
          eventsDelivered ? NEO_WORK_GOAL_PR_EVENTS : NEO_WORK_GOAL_PR_SUBSCRIBE,
        ]
      : []),
    NEO_WORK_GOAL_REMAINING,
    NEO_WORK_BLOCKER,
  ]);
}

function withTail(instruction: string, lines: readonly string[]): string {
  const tail = lines.join('\n');
  return `${instruction.slice(0, Math.max(0, WORK_MESSAGE_MAX - tail.length - 1))}\n${tail}`;
}

export function driverWorkCall(
  target: Exclude<NeoDriverTarget, { verb: 'read' }>,
  work: Pick<NeoWork, 'title' | 'instruction'>,
  goal: NeoWorkGoal | null = null,
  eventsDelivered = true
): { name: 'work.start' | 'work.send'; input: Record<string, unknown> } {
  const message = withWorkGoal(work.instruction, goal, eventsDelivered);
  return target.verb === 'start'
    ? {
        name: 'work.start',
        input: {
          adapter: target.adapter,
          place: target.place,
          title: work.title,
          message,
          ...(target.createFolder ? { createFolder: true } : {}),
          ...(target.model ? { model: target.model } : {}),
          ...(target.effort ? { effort: target.effort } : {}),
        },
      }
    : { name: 'work.send', input: { ref: target.ref, message } };
}

export function driverStartedReport(ref: WorkRef, link?: string, model?: string): string {
  const where = link ? ` It opens at ${link}.` : '';
  const runs = model ? ` It runs on ${model}.` : '';
  return `Handed to ${ref.adapter}${ref.daemon ? ` on ${ref.daemon}` : ''}.${runs}${where} Follow up with work.status ${JSON.stringify({ ref })}.`;
}

export function driverAdoptedReport(ref: WorkRef, status: WorkStatus, link?: string): string {
  const where = link ? ` It opens at ${link}.` : '';
  return `Tracking the ${ref.adapter} session${ref.daemon ? ` on ${ref.daemon}` : ''} the human started; adopting it sent it nothing. It was ${status} when adopted; the card settles only on what it does next, so judge a session that already finished, failed or stopped against doneWhen now and continue it with neo.work.continue.${where} Follow up with work.status ${JSON.stringify({ ref })}.`;
}

export function driverWorkCaller(work: Pick<NeoWork, 'originSessionId'>): OperationCaller {
  return { source: 'internal', sessionId: work.originSessionId, role: 'neo' };
}

export function readDriverOutcome(
  target: NeoDriverTarget,
  outcome: OperationOutcome
):
  | {
      ref: WorkRef;
      link?: string;
      model?: string;
      effort?: string;
      startedAt?: number;
      queued?: true;
      receipt?: WorkDelivery['receipt'];
    }
  | { failure: string; reason?: string } {
  if (outcome.kind === 'failed') return { failure: outcome.message };
  const reply = DriverReplySchema.safeParse(outcome.value);
  if (!reply.success) return { failure: 'The work operation returned an unusable reply.' };
  if (!reply.data.ok)
    return { failure: `${reply.data.reason}: ${reply.data.detail}`, reason: reply.data.reason };
  if ('ref' in reply.data.value) {
    const { ref, link, model, effort, lastActivityAt, receipt } = reply.data.value as {
      ref: WorkRef;
      link?: unknown;
      model?: unknown;
      effort?: unknown;
      lastActivityAt?: unknown;
      receipt?: unknown;
    };
    const started = WorkInputReceiptSchema.safeParse(receipt);
    return {
      ref,
      ...(typeof link === 'string' ? { link } : {}),
      ...(typeof model === 'string' ? { model } : {}),
      ...(typeof effort === 'string' ? { effort } : {}),
      ...(typeof lastActivityAt === 'number' ? { startedAt: lastActivityAt } : {}),
      ...(started.success ? { receipt: started.data } : {}),
    };
  }
  if (target.verb !== 'send') return { failure: 'work.start returned no reference.' };
  const { delivered, receipt } = reply.data.value;
  return {
    ref: target.ref,
    ...(delivered === false ? { queued: true as const } : {}),
    ...(receipt ? { receipt } : {}),
  };
}

const SETTLE_GRACE_MS = 10 * 60_000;

const DriverStatusSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    value: z
      .object({
        status: WorkStatusSchema,
        lastActivityAt: z.number(),
        lastReply: z.string().optional(),
        lastReplyAt: z.number().optional(),
        recentInputs: z.array(WorkInputSchema).optional(),
        exchange: z.array(WorkExchangeEntrySchema).optional(),
        exchangeCut: z.boolean().optional(),
        openedPrs: z.array(z.string()).optional(),
      })
      .passthrough(),
  }),
  z.object({ ok: z.literal(false), reason: z.string(), detail: z.string() }),
]);

type DriverStatusReply = z.infer<typeof DriverStatusSchema>;
type DriverStatus = Extract<DriverStatusReply, { ok: true }>['value'];

const parsedStatusReplies = new WeakMap<OperationOutcome, DriverStatusReply | null>();

function parseDriverStatusReply(outcome: OperationOutcome): DriverStatusReply | null {
  if (outcome.kind !== 'completed') return null;
  const cached = parsedStatusReplies.get(outcome);
  if (cached !== undefined) return cached;
  const reply = DriverStatusSchema.safeParse(outcome.value);
  const parsed = reply.success ? reply.data : null;
  parsedStatusReplies.set(outcome, parsed);
  return parsed;
}

function parseDriverStatus(outcome: OperationOutcome): DriverStatus | null {
  const reply = parseDriverStatusReply(outcome);
  return reply?.ok ? reply.value : null;
}

export function readDriverLive(outcome: OperationOutcome): {
  status: WorkStatus;
  lastActivityAt: number;
  lastReplyAt?: number;
  link?: string;
  remoteLink?: string;
} | null {
  const value = parseDriverStatus(outcome);
  if (!value) return null;
  const { status, lastActivityAt, lastReplyAt, link, remoteLink } = value as {
    status: WorkStatus;
    lastActivityAt: number;
    lastReplyAt?: number;
    link?: unknown;
    remoteLink?: unknown;
  };
  return {
    status,
    lastActivityAt,
    ...(lastReplyAt !== undefined ? { lastReplyAt } : {}),
    ...(typeof link === 'string' ? { link } : {}),
    ...(typeof remoteLink === 'string' ? { remoteLink } : {}),
  };
}

export function decideCardLiveStatus(
  session: { status: WorkStatus; lastActivityAt: number; lastReplyAt?: number },
  anchoredAt: number | null,
  prior: WorkStatus | null
): WorkStatus {
  if (session.status === 'failed' || session.status === 'stopped') return session.status;
  if (anchoredAt === null) return 'queued';
  const replied = session.lastReplyAt !== undefined && session.lastReplyAt > anchoredAt;
  if (!replied) return session.status === 'done' ? 'running' : session.status;
  if (session.status === 'running') return prior === 'done' ? 'done' : 'running';
  return session.status === 'needs_you' ? 'needs_you' : 'done';
}

export const NEO_CARD_CONFIRM_MS = 24 * 60 * 60_000;

export function isNeoCardUnconfirmed(
  work: Pick<NeoWork, 'createdAt'>,
  sent: Pick<DriverSent, 'inputBefore'> | null,
  now: number
): boolean {
  return now - Math.max(work.createdAt, sent?.inputBefore ?? 0) >= NEO_CARD_CONFIRM_MS;
}

export const NEO_DRIVER_START_INTERRUPTED = 'Starting was interrupted before';

export type NeoWorkRetryCard = { target: boolean; ref: boolean; interrupted: boolean };

export function requireNeoWorkRetryable<T>(
  work: Pick<NeoWork, 'status'> & Partial<Pick<NeoWork, 'report'>>,
  card: NeoWorkRetryCard,
  admitted: T
): { value: T } | { reason: { ok: false; reason: string } } {
  if (card.interrupted)
    return {
      reason: {
        ok: false,
        reason:
          'Starting was interrupted and it may have started anyway; check work.find before proposing it again.',
      },
    };
  return (work.status === 'failed' ||
    awaitingNeoWorker({ ...work, report: work.report ?? null })) &&
    card.target &&
    !card.ref
    ? { value: admitted }
    : {
        reason: {
          ok: false,
          reason:
            'Only a hand-off that failed before it started can be retried; use neo.work.continue for started work.',
        },
      };
}

export function isNeoReceiptUnconfirmed(
  card: {
    ref: boolean;
    workStatus: string | null;
    workCreatedAt: number | null;
    startedAt: number | null;
    inputBefore: number | null;
    status: WorkStatus | null;
  },
  now: number
): boolean {
  return (
    card.ref &&
    card.workStatus === 'queued' &&
    card.workCreatedAt !== null &&
    card.startedAt === null &&
    card.status !== null &&
    card.status !== 'queued' &&
    isNeoCardUnconfirmed(
      { createdAt: card.workCreatedAt },
      card.inputBefore === null ? null : { inputBefore: card.inputBefore },
      now
    )
  );
}

export function readDriverSendBaseline(
  outcome: OperationOutcome,
  sentAt: number,
  remote: boolean
): number | null {
  const fallback = remote ? null : sentAt;
  const value = parseDriverStatus(outcome);
  if (!value) return fallback;
  const { status, lastActivityAt } = value;
  return status === 'running' || status === 'needs_you' ? null : lastActivityAt;
}

export interface DriverSent {
  inputBefore: number;
  opening: string;
  receipt?: WorkDelivery['receipt'];
}

export function readDriverStartReceipt(outcome: OperationOutcome): WorkDelivery['receipt'] | null {
  const value = parseDriverStatus(outcome) as { startReceipt?: unknown } | null;
  const parsed = WorkInputReceiptSchema.safeParse(value?.startReceipt);
  return parsed.success ? parsed.data : null;
}

export function planNeoStartReceiptAdoption(
  outcome: OperationOutcome,
  sent: DriverSent | null,
  verb: string | undefined
): DriverSent | null {
  if (verb !== 'start' || !sent || sent.receipt) return null;
  const receipt = readDriverStartReceipt(outcome);
  return receipt ? { ...sent, receipt } : null;
}

export function messageOpening(message: string): string {
  return message.trim().split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function readDriverInputs(outcome: OperationOutcome): WorkInput[] | null {
  return parseDriverStatus(outcome)?.recentInputs ?? null;
}

export function readDriverAdoptedSent(outcome: OperationOutcome): DriverSent | null {
  const value = parseDriverStatus(outcome);
  const input = (
    value?.recentInputs ?? value?.exchange?.filter((entry) => entry.role === 'user')
  )?.at(-1);
  const opening = input ? messageOpening(input.text) : '';
  return input && opening ? { inputBefore: input.at - 1, opening } : null;
}

export function readDriverOpenedPrs(outcome: OperationOutcome): string[] {
  return parseDriverStatus(outcome)?.openedPrs ?? [];
}

export function readDriverLastInputAt(outcome: OperationOutcome): number | null {
  const inputs = readDriverInputs(outcome);
  return inputs?.length ? Math.max(...inputs.map((input) => input.at)) : null;
}

export function readDriverSent(
  outcome: OperationOutcome,
  message: string,
  floor = 0
): DriverSent | null {
  const opening = messageOpening(message);
  if (!opening) return null;
  const inputs = readDriverInputs(outcome);
  return {
    inputBefore: inputs ? Math.max(0, ...inputs.map((input) => input.at)) : floor,
    opening,
  };
}

export function neoCardSent(
  stored: DriverSent | null,
  work: Pick<NeoWork, 'instruction' | 'createdAt'> | null
): DriverSent | null {
  const opening = work ? messageOpening(work.instruction) : '';
  return stored ?? (work && opening ? { inputBefore: work.createdAt, opening } : null);
}

export function readDriverLanded(
  outcome: OperationOutcome,
  sent: DriverSent | null
): number | null {
  if (!sent) return null;
  const landed = readDriverInputs(outcome)?.find(
    (input) => input.at > sent.inputBefore && input.text.includes(sent.opening)
  );
  return landed?.at ?? null;
}

export function readDriverNeedsYou(
  outcome: OperationOutcome
): { needsYou: boolean; since: number; lastReply?: string } | null {
  const value = parseDriverStatus(outcome);
  if (!value) return null;
  const { status, lastActivityAt, lastReply } = value;
  return { needsYou: status === 'needs_you', since: lastActivityAt, lastReply };
}

const NEO_DRIVER_NO_REPLY = 'It finished without a written reply.';

export interface NeoAskCard {
  id: string;
  title: string;
  status: NeoWork['status'];
  prs?: NeoWorkPr[];
}

const NEO_ASK_CARDS_MAX = 10;

export function projectNeoAskCards(
  workId: string,
  works: readonly Pick<NeoWork, 'id' | 'title' | 'status'>[],
  prRows: readonly { workId: string; prs: NeoWorkPr[] }[]
): NeoAskCard[] {
  const prs = new Map(prRows.map((row) => [row.workId, row.prs]));
  return works
    .filter((work) => work.id !== workId)
    .slice(-NEO_ASK_CARDS_MAX)
    .map((work) => {
      const linked = prs.get(work.id);
      return {
        id: work.id,
        title: work.title,
        status: work.status,
        ...(linked ? { prs: linked } : {}),
      };
    });
}

export function isNeoDoneWhenRestated(doneWhen: string, ask: NeoAsk): boolean {
  const texts = new Set(
    (ask.doneItems ?? []).filter((item) => !item.removed).map((item) => item.text.trim())
  );
  const lines = doneWhen
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => texts.has(line));
}

export function neoNotePrVerdict(prs: readonly NeoWorkPr[]) {
  const verdicts = prs.map(neoWorkPrVerdict);
  return verdicts.find((verdict) => verdict !== 'done') ?? verdicts[0];
}

export function neoNoteCards(cards: readonly NeoAskCard[]) {
  return cards.map(({ id, title, status, prs }) => {
    const pr = neoNotePrVerdict(prs ?? []);
    return { id, title, status, ...(pr ? { pr } : {}) };
  });
}

export function driverDoneCheckNote(
  work: Pick<NeoWork, 'id' | 'title' | 'report' | 'originSessionId'>,
  goal: NeoWorkGoal,
  continued: number,
  {
    facts = null,
    continuation,
    ask,
    pack = null,
    cards = [],
    move = '',
  }: {
    stalled?: number;
    continuation?: ReturnType<typeof neoContinueFacts>;
    facts?: NeoPackCardFacts | null;
    ask?: NeoAsk | null;
    pack?: NeoPackFragment | null;
    cards?: readonly NeoAskCard[];
    move?: string;
  } = {}
): string {
  const owned = !!ask && ask.originSessionId === work.originSessionId;
  const next = '';
  const owner = !ask
    ? ''
    : owned
      ? ` ${fillPrompt(NEO_WORK_DONE_CHECK_ASK_OWNED, { ask_id: ask.id })}`
      : ` ${fillPrompt(NEO_WORK_DONE_CHECK_ASK_FOREIGN, { ask_id: ask.id })}`;
  const packNote = pack ? `\n${fillPrompt(NEO_WORK_PACK_NOTE, { pack: pack.id })}` : '';
  const items = owned && ask ? neoNoteChecklist(ask) : [];
  const restates = (doneWhen: string | null | undefined) =>
    !!ask && items.length > 0 && isNeoDoneWhenRestated(doneWhen ?? '', ask);
  return neoAskProgressNote(
    ask ?? null,
    `${fillPrompt(NEO_WORK_DONE_CHECK, { work_id: work.id, title: work.title, facts: facts ? ` ${facts.text}` : '', ask: owner, next })}${move}${packNote}`,
    {
      card: {
        id: work.id,
        title: work.title,
        goal: goal.goal,
        ...(restates(goal.doneWhen) ? {} : { doneWhen: goal.doneWhen }),
        continued,
        continuation,
        report: work.report?.slice(0, 12000) ?? null,
        ...facts?.data,
      },
      ...(ask && !restates(ask.doneWhen) ? { askDoneWhen: ask.doneWhen } : {}),
      ...(owned ? { cards: neoNoteCards(cards) } : { items: undefined }),
    }
  );
}

export function neoWorkDoneGoal(
  workId: string,
  goal: NeoWorkGoal | null,
  ask: NeoAsk | null
): NeoWorkGoal | null {
  const doneWhen = goal?.doneWhen ?? ask?.doneWhen ?? null;
  return doneWhen ? { workId, goal: goal?.goal ?? ask?.ask ?? null, doneWhen } : null;
}

export const NEO_WORK_STALL_MS = 20 * 60_000;

export function readDriverActivity(
  outcome: OperationOutcome
): { status: string; lastActivityAt: number; lastReply?: string } | null {
  const value = parseDriverStatus(outcome);
  if (!value) return null;
  const { status, lastActivityAt, lastReply } = value;
  return { status, lastActivityAt, lastReply };
}

export function driverStallNote(
  work: Pick<NeoWork, 'id' | 'title'>,
  ask: NeoAsk | null,
  goal: NeoWorkGoal | null,
  lastReply: string | undefined
): string {
  const next = '';
  return neoAskProgressNote(
    ask,
    fillPrompt(NEO_WORK_STALL, { work_id: work.id, title: work.title, next }),
    {
      card: {
        id: work.id,
        title: work.title,
        goal: goal?.goal ?? null,
        doneWhen: goal?.doneWhen ?? null,
        lastReply: lastReply?.slice(0, 2000) ?? null,
      },
    }
  );
}

const HOUR_MS = 60 * 60_000;

export const NEO_WORK_STUCK_STEPS_MS = [2 * HOUR_MS, 24 * HOUR_MS, 48 * HOUR_MS, 72 * HOUR_MS];

export function decideStuckReminder(
  queuedSince: number,
  now: number
): { due: number; abandoned: boolean } | null {
  const reached = NEO_WORK_STUCK_STEPS_MS.filter((ms) => now - queuedSince >= ms);
  if (reached.length === 0) return null;
  return {
    due: queuedSince + reached[reached.length - 1],
    abandoned: reached.length === NEO_WORK_STUCK_STEPS_MS.length,
  };
}

export function isNeoReceiptAbandoned(
  workStatus: string | null,
  queuedSince: number | null,
  now: number
): boolean {
  return (
    workStatus === 'queued' &&
    queuedSince !== null &&
    !!decideStuckReminder(queuedSince, now)?.abandoned
  );
}

export function driverStuckNote(
  work: Pick<NeoWork, 'id' | 'title'>,
  ask: NeoAsk | null,
  goal: NeoWorkGoal | null,
  queuedSince: number,
  now: number,
  abandoned: boolean
): string {
  const hours = Math.floor((now - queuedSince) / HOUR_MS);
  const next = abandoned ? NEO_WORK_STUCK_ABANDONED : '';
  return neoAskProgressNote(
    ask,
    fillPrompt(NEO_WORK_STUCK, { work_id: work.id, title: work.title, hours: String(hours), next }),
    {
      card: {
        id: work.id,
        title: work.title,
        goal: goal?.goal ?? null,
        doneWhen: goal?.doneWhen ?? null,
      },
    }
  );
}

export function driverNeedsYouNote(
  work: Pick<NeoWork, 'id' | 'title'>,
  ask: NeoAsk | null,
  ref: WorkRef,
  lastReply: string | undefined
): string {
  return neoAskProgressNote(
    ask,
    fillPrompt(NEO_WORK_NEEDS_YOU, { work_id: work.id, title: work.title }),
    { card: { id: work.id, title: work.title, ref, lastReply: lastReply?.slice(0, 2000) ?? null } }
  );
}

export function readDriverCardExchange(outcome: OperationOutcome, sent: DriverSent | null) {
  const value = parseDriverStatus(outcome);
  if (!value || !sent) return null;
  const entries = value.exchange ?? [];
  const start = entries.findIndex(
    (entry) =>
      entry.role === 'user' &&
      entry.at > sent.inputBefore &&
      entry.text.replace(/\s+/g, ' ').includes(sent.opening)
  );
  if (start < 0) return null;
  const next = entries.findIndex((entry, index) => index > start && entry.role === 'user');
  const replies = entries.slice(start + 1, next < 0 ? undefined : next);
  return {
    current: next < 0,
    start: entries[start].at,
    end:
      next < 0 && ['running', 'queued', 'needs_you'].includes(value.status)
        ? null
        : (replies.at(-1)?.at ?? entries[start].at),
    replies,
  };
}

export function isDriverCardCurrent(outcome: OperationOutcome, sent: DriverSent | null): boolean {
  const value = parseDriverStatus(outcome);
  if (!value) return false;
  if (value.exchange !== undefined) return readDriverCardExchange(outcome, sent)?.current ?? false;
  return (
    !sent ||
    !(value.recentInputs ?? []).some(
      (input) =>
        input.at > sent.inputBefore && !input.text.replace(/\s+/g, ' ').includes(sent.opening)
    )
  );
}

const EXCHANGE_REPORT_LIMIT = 12_000;

export function driverExchangeReport(
  exchange: readonly WorkExchangeEntry[] | undefined,
  cut: boolean,
  opening: string | null
): string | null {
  const entries = exchange ?? [];
  const own = entries.findIndex(
    (entry) =>
      entry.role === 'user' && !!opening && entry.text.replace(/\s+/g, ' ').includes(opening)
  );
  if (opening && own < 0) return null;
  const next = entries.findIndex((entry, index) => index > own && entry.role === 'user');
  const parts = (opening ? entries.slice(own + 1, next < 0 ? undefined : next) : entries)
    .filter((entry) => !opening || entry.role === 'agent')
    .map((entry) => `${entry.role === 'agent' ? 'Agent' : 'Input'}: ${entry.text}`);
  if (!parts.some((part) => part.startsWith('Agent: '))) return null;
  const head = cut ? ['(Earlier messages were not read; this is not the whole exchange.)'] : [];
  const whole = [...head, ...parts].join('\n\n');
  if (whole.length <= EXCHANGE_REPORT_LIMIT) return whole;
  const tail: string[] = [];
  let size = [...head, parts[0]].join('\n\n').length + 60;
  for (let index = parts.length - 1; index > 0; index--) {
    if (size + parts[index].length + 2 > EXCHANGE_REPORT_LIMIT) break;
    tail.unshift(parts[index]);
    size += parts[index].length + 2;
  }
  const trimmed = parts.length - 1 - tail.length;
  return [...head, parts[0], `(${trimmed} messages in between trimmed.)`, ...tail].join('\n\n');
}

export const NEO_WORK_UNANCHORED_SETTLE_MS = 3 * 60 * 60 * 1000;

export const NEO_WORK_UNANCHORED_NOTE =
  "Neo's message was never found in that session, so this is the session's latest reply, not a confirmed answer to the work item. Check it against the work item before telling the human.";

export const NEO_WORK_UNVERIFIED_REPLY_NOTE =
  'Reply attribution is unverified: matching input/reply history was unavailable. Check this latest reply against the work item before treating it as its answer.';

function unverifiedDriverReply(reply: string | undefined): string | null {
  return reply ? `${NEO_WORK_UNVERIFIED_REPLY_NOTE}\n\n${reply}` : null;
}

type DriverInputAttribution =
  | { state: 'observed'; replies: WorkExchangeEntry[]; cut: boolean }
  | { state: 'pending' }
  | { state: 'unverified' };

export function readDriverInputAttribution(
  outcome: OperationOutcome,
  receipt: WorkDelivery['receipt'] | undefined
): DriverInputAttribution | null {
  const value = receipt ? parseDriverStatus(outcome) : null;
  if (!receipt || !value) return null;
  const evidence = WorkInputEvidenceSchema.safeParse(value.inputEvidence);
  const found = evidence.success ? evidence.data : null;
  if (
    !found ||
    found.receipt.executionId !== receipt.executionId ||
    found.receipt.inputId !== receipt.inputId
  )
    return { state: 'unverified' };
  if (found.state !== 'observed')
    return { state: found.state === 'pending' ? 'pending' : 'unverified' };
  return {
    state: 'observed',
    replies: found.exchange.filter((entry) => entry.role === 'agent'),
    cut: found.exchangeCut,
  };
}

export const NEO_WORK_LATER_REPLIES_CUT =
  '(Later replies were not read; this is not the whole exchange.)';

function attributedDriverReport(attribution: {
  replies: readonly WorkExchangeEntry[];
  cut: boolean;
}): string | null {
  const report = driverExchangeReport(attribution.replies, false, null);
  return report && attribution.cut ? `${report}\n\n${NEO_WORK_LATER_REPLIES_CUT}` : report;
}

function settleAttributedDriverWork(
  status: WorkStatus,
  attribution: Exclude<DriverInputAttribution, { state: 'unverified' }>
): { status: 'reported' | 'failed'; report: string } | null {
  const said = attribution.state === 'observed' ? attributedDriverReport(attribution) : null;
  if (status === 'done' && attribution.state === 'observed')
    return { status: 'reported', report: said ?? NEO_DRIVER_NO_REPLY };
  if (status === 'failed' || status === 'stopped')
    return {
      status: 'failed',
      report:
        attribution.state === 'pending'
          ? `It ${status} before it read the message.`
          : `It ${status}.${said ? ` ${said}` : ''}`,
    };
  return null;
}

function readUnanchoredSettlement(
  work: Pick<NeoWork, 'updatedAt'>,
  value: { status: string; lastActivityAt: number; lastReplyAt?: number; lastReply?: string },
  now: number
): { status: 'reported'; report: string } | null {
  if (value.status !== 'done' || value.lastReplyAt === undefined) return null;
  if (value.lastReplyAt <= work.updatedAt) return null;
  if (now - value.lastActivityAt < NEO_WORK_UNANCHORED_SETTLE_MS) return null;
  return {
    status: 'reported',
    report: `${NEO_WORK_UNANCHORED_NOTE}\n\n${value.lastReply || NEO_DRIVER_NO_REPLY}`,
  };
}

export function readDriverFollowUp(
  outcome: OperationOutcome,
  since: number,
  sent: DriverSent | null = null
): string | null {
  const value = parseDriverStatus(outcome);
  if (!value || value.status === 'running' || value.status === 'queued') return null;
  const attribution = readDriverInputAttribution(outcome, sent?.receipt);
  if (attribution?.state === 'pending') return null;
  if (attribution?.state === 'observed')
    return attributedDriverReport({
      ...attribution,
      replies: attribution.replies.filter((entry) => entry.at > since),
    });
  if (value.exchange === undefined)
    return (value.lastReplyAt ?? value.lastActivityAt) > since && isDriverCardCurrent(outcome, sent)
      ? unverifiedDriverReply(value.lastReply)
      : null;
  const own = readDriverCardExchange(outcome, sent);
  const replies = own?.replies.filter((entry) => entry.at > since);
  const report = replies?.length ? driverExchangeReport(replies, false, null) : null;
  return attribution ? unverifiedDriverReply(report ?? undefined) : report;
}

export function readDriverSettlement(
  work: Pick<NeoWork, 'updatedAt'>,
  outcome: OperationOutcome,
  now: number,
  startedAt: number | null = null,
  requireFresh = false,
  opening: string | null = null,
  receipt?: WorkDelivery['receipt']
): { status: 'reported' | 'failed'; report: string } | null {
  const reply = parseDriverStatusReply(outcome);
  if (!reply) return null;
  if (!reply.ok) {
    return reply.reason === 'not_found'
      ? { status: 'failed', report: `The work is gone: ${reply.detail}` }
      : null;
  }
  const { status, lastActivityAt, lastReplyAt, exchange, exchangeCut } = reply.value;
  const attribution = readDriverInputAttribution(outcome, receipt);
  if (attribution && attribution.state !== 'unverified')
    return settleAttributedDriverWork(status, attribution);
  if (requireFresh && startedAt === null)
    return opening ? null : readUnanchoredSettlement(work, reply.value, now);
  const fresh = lastActivityAt > (startedAt ?? work.updatedAt);
  if (!fresh && (requireFresh || now - work.updatedAt < SETTLE_GRACE_MS)) return null;
  const report = driverExchangeReport(exchange, exchangeCut ?? false, opening);
  if (opening && !report && exchange !== undefined) return null;
  if (
    exchange === undefined &&
    opening &&
    !isDriverCardCurrent(outcome, {
      opening,
      inputBefore: (startedAt ?? work.updatedAt) - 1,
    })
  )
    return null;
  const said =
    report && !attribution ? report : unverifiedDriverReply(report ?? reply.value.lastReply);
  if (status === 'done') {
    const staleReply =
      requireFresh && startedAt !== null && lastReplyAt !== undefined && lastReplyAt <= startedAt;
    if (staleReply) return null;
    return { status: 'reported', report: said || NEO_DRIVER_NO_REPLY };
  }
  if (status === 'failed' || status === 'stopped') {
    return { status: 'failed', report: `It ${status}.${said ? ` ${said}` : ''}` };
  }
  return null;
}

import {
  fillPrompt,
  NEO_WORK_DONE_CHECK,
  NEO_WORK_DONE_CHECK_ASK_FOREIGN,
  NEO_WORK_DONE_CHECK_ASK_NEXT,
  NEO_WORK_DONE_CHECK_ASK_OWNED,
  NEO_WORK_DONE_CHECK_BUDGET,
  NEO_WORK_DONE_CHECK_CONTINUE,
  NEO_WORK_DONE_CHECK_PRS_LIVE,
  NEO_WORK_DONE_CHECK_PRS_STALE,
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
  NEO_WORK_STALL_BUDGET,
  NEO_WORK_STALL_CHECK,
  NEO_WORK_STUCK,
  NEO_WORK_STUCK_ABANDONED,
  NEO_WORK_STUCK_BUDGET,
  NEO_WORK_STUCK_CHECK,
  NEO_WORK_SUMMARY_NOTE,
} from '@hyperneo/prompts';
import { z } from 'zod';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  isPooledNeoAsk,
  neoAskApprovalSpent,
  neoWorkPrVerdict,
  NEO_WORK_STALLED_CONTINUES,
  type NeoWorkContinue,
  type NeoWorkGoal,
  type NeoAsk,
  type NeoWorkPr,
} from '@hyperneo/shared/types/neo-snapshot';
import {
  PlaceSchema,
  WorkExchangeEntrySchema,
  WorkInputSchema,
  WorkRefSchema,
  WorkStatusSchema,
  type WorkExchangeEntry,
  type WorkInput,
  type WorkRef,
  type WorkStatus,
} from '../drivers/types.ts';
import type { NeoPackFragment } from './packs/types.ts';
import { hashString32 } from '../runtime-hash.ts';
import { WORK_MESSAGE_MAX, WorkAdaptersResultSchema } from '../drivers/work-operations.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { awaitingNeoWorker } from './work-reroute.ts';
import { workStartConfiguration } from '../drivers/start-configuration.ts';
import { NeoReadWorkTarget } from './read-work.ts';

export const NeoDriverTargetSchema = z.discriminatedUnion('verb', [
  NeoReadWorkTarget,
  z.object({
    verb: z.literal('start'),
    adapter: z.string().min(1).max(80),
    place: PlaceSchema,
    createFolder: z.boolean().optional(),
    ...workStartConfiguration.schema.shape,
  }),
  z.object({ verb: z.literal('send'), ref: WorkRefSchema }),
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
    value: z.union([
      z.object({ ref: WorkRefSchema }).passthrough(),
      z.object({ delivered: z.boolean() }),
    ]),
  }),
  z.object({ ok: z.literal(false), reason: z.string(), detail: z.string() }),
]);

const NEO_WORK_CONTINUE_WINDOW_MS = 12 * 60 * 60 * 1000;

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

export function neoStalledContinues(
  continued: Pick<NeoWorkContinue, 'progress' | 'stalled'> | null,
  progress: string
): number {
  return continued && continued.progress === progress ? continued.stalled + 1 : 0;
}

export function readContinueBudget(
  stalledWakes: number,
  startedAt: number | null,
  now: number
): string | null {
  if (stalledWakes >= NEO_WORK_STALLED_CONTINUES)
    return `continue_budget_spent: your last ${NEO_WORK_STALLED_CONTINUES} wakes for this card brought no new commit, PR state, review, report or met item; tell the human what is stuck and ask how to proceed.`;
  if (startedAt !== null && now - startedAt >= NEO_WORK_CONTINUE_WINDOW_MS)
    return 'continue_budget_spent: this work started over 12 hours ago; ask the human how to proceed.';
  return null;
}

export function neoContinuesLeft(stalled: number): number {
  return Math.max(0, NEO_WORK_STALLED_CONTINUES - stalled);
}

export function readNeoWorkContinueBudget(
  stalledWakes: number,
  startedAt: number | null,
  ask: Pick<NeoAsk, 'status' | 'approvedAt' | 'approvedContinues'> | null,
  now: number
): string | null {
  if (!ask || !isPooledNeoAsk(ask)) return readContinueBudget(stalledWakes, startedAt, now);
  const stalled = readContinueBudget(stalledWakes, null, now);
  if (stalled) return stalled;
  return neoAskApprovalSpent(ask, now) === 'expired'
    ? 'continue_budget_spent: this ask was approved over 48 hours ago; ask the human to approve it again.'
    : null;
}

export function withWorkGoal(
  instruction: string,
  goal: NeoWorkGoal | null,
  eventsDelivered = true
): string {
  if (!goal?.goal && !goal?.doneWhen) return instruction;
  const tail = [
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
  ].join('\n');
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
    }
  | { failure: string; reason?: string } {
  if (outcome.kind === 'failed') return { failure: outcome.message };
  const reply = DriverReplySchema.safeParse(outcome.value);
  if (!reply.success) return { failure: 'The work operation returned an unusable reply.' };
  if (!reply.data.ok)
    return { failure: `${reply.data.reason}: ${reply.data.detail}`, reason: reply.data.reason };
  if ('ref' in reply.data.value) {
    const { ref, link, model, effort, lastActivityAt } = reply.data.value as {
      ref: WorkRef;
      link?: unknown;
      model?: unknown;
      effort?: unknown;
      lastActivityAt?: unknown;
    };
    return {
      ref,
      ...(typeof link === 'string' ? { link } : {}),
      ...(typeof model === 'string' ? { model } : {}),
      ...(typeof effort === 'string' ? { effort } : {}),
      ...(typeof lastActivityAt === 'number' ? { startedAt: lastActivityAt } : {}),
    };
  }
  if (target.verb !== 'send') return { failure: 'work.start returned no reference.' };
  const { delivered } = reply.data.value as { delivered?: unknown };
  return delivered === false ? { ref: target.ref, queued: true } : { ref: target.ref };
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
}

export function messageOpening(message: string): string {
  return message.trim().split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 80);
}

function readDriverInputs(outcome: OperationOutcome): WorkInput[] | null {
  return parseDriverStatus(outcome)?.recentInputs ?? null;
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

export { NEO_WORK_SUMMARY_NOTE };

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

export function neoNoteChecklist(ask: NeoAsk): { id: string; state: string; text?: string }[] {
  return (ask.doneItems ?? [])
    .filter((item) => !item.removed)
    .map(({ id, text, state }) => (state === 'met' ? { id, state } : { id, state, text }));
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

export function neoNotePrs(prs: readonly NeoWorkPr[]) {
  return prs.map(({ url, state, checks, review, blockers }) => ({
    url,
    state,
    checks,
    review,
    ...(blockers?.length ? { blockers } : {}),
  }));
}

export function driverDoneCheckNote(
  work: Pick<NeoWork, 'id' | 'title' | 'report' | 'originSessionId'>,
  goal: NeoWorkGoal,
  continued: number,
  budget: string | null,
  {
    stalled = 0,
    prs,
    stale = false,
    ask,
    pack = null,
    cards = [],
  }: {
    stalled?: number;
    prs?: readonly NeoWorkPr[];
    stale?: boolean;
    ask?: NeoAsk | null;
    pack?: NeoPackFragment | null;
    cards?: readonly NeoAskCard[];
  } = {}
): string {
  const live = !prs
    ? ''
    : stale
      ? ` ${NEO_WORK_DONE_CHECK_PRS_STALE}`
      : ` ${NEO_WORK_DONE_CHECK_PRS_LIVE}`;
  const owned = !!ask && ask.originSessionId === work.originSessionId;
  const summary = owned ? NEO_WORK_DONE_CHECK_ASK_NEXT : NEO_WORK_SUMMARY_NOTE;
  const next = budget
    ? fillPrompt(NEO_WORK_DONE_CHECK_BUDGET, { budget, summary })
    : fillPrompt(NEO_WORK_DONE_CHECK_CONTINUE, {
        continues_left: String(neoContinuesLeft(stalled)),
        summary,
      });
  const owner = !ask
    ? ''
    : owned
      ? ` ${fillPrompt(NEO_WORK_DONE_CHECK_ASK_OWNED, { ask_id: ask.id })}`
      : ` ${fillPrompt(NEO_WORK_DONE_CHECK_ASK_FOREIGN, { ask_id: ask.id })}`;
  const packNote = pack
    ? `\n${fillPrompt(NEO_WORK_PACK_NOTE, { pack: pack.id })}${pack.inPrompt ? '' : `\n${pack.instructions}`}`
    : '';
  const items = owned && ask ? neoNoteChecklist(ask) : [];
  const restates = (doneWhen: string | null | undefined) =>
    !!ask && items.length > 0 && isNeoDoneWhenRestated(doneWhen ?? '', ask);
  return `${fillPrompt(NEO_WORK_DONE_CHECK, { prs: live, ask: owner, next })}${packNote}\n${JSON.stringify({ workId: work.id, title: work.title, goal: goal.goal, ...(restates(goal.doneWhen) ? {} : { doneWhen: goal.doneWhen }), continued, report: work.report?.slice(0, 12000) ?? null, ...(prs ? { prs: neoNotePrs(prs) } : {}), ...(ask ? { ask: { id: ask.id, ...(restates(ask.doneWhen) ? {} : { doneWhen: ask.doneWhen }), status: ask.status, ...(owned ? { cards: neoNoteCards(cards), items } : {}) } } : {}) })}`;
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
  goal: NeoWorkGoal | null,
  lastReply: string | undefined,
  budget: string | null
): string {
  const next = budget ? fillPrompt(NEO_WORK_STALL_BUDGET, { budget }) : NEO_WORK_STALL_CHECK;
  return `${fillPrompt(NEO_WORK_STALL, { next })}\n${JSON.stringify({ workId: work.id, title: work.title, goal: goal?.goal ?? null, doneWhen: goal?.doneWhen ?? null, lastReply: lastReply?.slice(0, 2000) ?? null })}`;
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
  goal: NeoWorkGoal | null,
  queuedSince: number,
  now: number,
  abandoned: boolean,
  budget: string | null
): string {
  const hours = Math.floor((now - queuedSince) / HOUR_MS);
  const next = abandoned
    ? NEO_WORK_STUCK_ABANDONED
    : budget
      ? fillPrompt(NEO_WORK_STUCK_BUDGET, { budget })
      : NEO_WORK_STUCK_CHECK;
  return `${fillPrompt(NEO_WORK_STUCK, { hours: String(hours), next })}\n${JSON.stringify({ workId: work.id, title: work.title, goal: goal?.goal ?? null, doneWhen: goal?.doneWhen ?? null })}`;
}

export function driverNeedsYouNote(
  work: Pick<NeoWork, 'id' | 'title'>,
  ref: WorkRef,
  lastReply: string | undefined
): string {
  return `${NEO_WORK_NEEDS_YOU}\n${JSON.stringify({ workId: work.id, title: work.title, ref, lastReply: lastReply?.slice(0, 2000) ?? null })}`;
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
  const parts = entries
    .filter((_, index) => index !== own)
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

export function readDriverFollowUp(outcome: OperationOutcome, since: number): string | null {
  const value = parseDriverStatus(outcome);
  if (!value || value.status === 'running' || value.status === 'queued') return null;
  if (value.lastActivityAt <= since) return null;
  const said = driverExchangeReport(value.exchange, value.exchangeCut ?? false, null);
  if (said) return said;
  return value.lastReplyAt !== undefined && value.lastReplyAt > since && value.lastReply
    ? `Agent: ${value.lastReply}`
    : null;
}

export function readDriverSettlement(
  work: Pick<NeoWork, 'updatedAt'>,
  outcome: OperationOutcome,
  now: number,
  startedAt: number | null = null,
  requireFresh = false,
  opening: string | null = null
): { status: 'reported' | 'failed'; report: string } | null {
  const reply = parseDriverStatusReply(outcome);
  if (!reply) return null;
  if (!reply.ok) {
    return reply.reason === 'not_found'
      ? { status: 'failed', report: `The work is gone: ${reply.detail}` }
      : null;
  }
  const { status, lastActivityAt, lastReplyAt, exchange, exchangeCut } = reply.value;
  if (requireFresh && startedAt === null) return readUnanchoredSettlement(work, reply.value, now);
  const fresh = lastActivityAt > (startedAt ?? work.updatedAt);
  if (!fresh && (requireFresh || now - work.updatedAt < SETTLE_GRACE_MS)) return null;
  const said =
    driverExchangeReport(exchange, exchangeCut ?? false, opening) ?? reply.value.lastReply;
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

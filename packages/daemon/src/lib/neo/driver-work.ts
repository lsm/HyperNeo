import {
  fillPrompt,
  NEO_WORK_DONE_CHECK,
  NEO_WORK_DONE_CHECK_ASK_FOREIGN,
  NEO_WORK_DONE_CHECK_ASK_NEXT,
  NEO_WORK_DONE_CHECK_ASK_OWNED,
  NEO_WORK_DONE_CHECK_BUDGET,
  NEO_WORK_DONE_CHECK_CONTINUE,
  NEO_WORK_DONE_CHECK_PRS_LIVE,
  NEO_WORK_DONE_CHECK_PRS_READY,
  NEO_WORK_DONE_CHECK_PRS_STALE,
  NEO_WORK_GOAL,
  NEO_WORK_GOAL_ASKED,
  NEO_WORK_GOAL_DONE_WHEN,
  NEO_WORK_GOAL_MERGE,
  NEO_WORK_GOAL_REMAINING,
  NEO_WORK_NEEDS_YOU,
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
  NEO_WORK_CONTINUE_LIMIT,
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
import { WorkAdaptersResultSchema } from '../drivers/work-operations.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import type { OperationCaller } from '../operations/registry.ts';

export const NeoDriverTargetSchema = z.discriminatedUnion('verb', [
  z.object({
    verb: z.literal('start'),
    adapter: z.string().min(1).max(80),
    place: PlaceSchema,
    createFolder: z.boolean().optional(),
    model: z.string().trim().min(1).max(200).optional(),
  }),
  z.object({ verb: z.literal('send'), ref: WorkRefSchema }),
]);

export type NeoDriverTarget = z.infer<typeof NeoDriverTargetSchema>;
type NeoDriverAdapter = { id: string; capabilities: readonly string[] };

export function driverTargetDaemon(target: NeoDriverTarget): string | undefined {
  return target.verb === 'start' ? target.place.daemon : target.ref.daemon;
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
  if (!target || !adapters) return { value };
  const id = target.verb === 'start' ? target.adapter : target.ref.adapter;
  if (adapters.some((item) => item.id === id && item.capabilities.includes(target.verb)))
    return { value };
  const able = adapters.filter((item) => item.capabilities.includes(target.verb));
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

export const NEO_WORK_CONTINUE_WINDOW_MS = 12 * 60 * 60 * 1000;

export function readContinueBudget(
  continued: Pick<NeoWorkContinue, 'count'> | null,
  startedAt: number | null,
  now: number
): string | null {
  if ((continued?.count ?? 0) >= NEO_WORK_CONTINUE_LIMIT)
    return `continue_budget_spent: already continued ${NEO_WORK_CONTINUE_LIMIT} times; ask the human how to proceed.`;
  if (startedAt !== null && now - startedAt >= NEO_WORK_CONTINUE_WINDOW_MS)
    return 'continue_budget_spent: this work started over 12 hours ago; ask the human how to proceed.';
  return null;
}

export function withWorkGoal(instruction: string, goal: NeoWorkGoal | null): string {
  if (!goal?.goal && !goal?.doneWhen) return instruction;
  return [
    instruction,
    '',
    NEO_WORK_GOAL,
    ...(goal.goal ? [fillPrompt(NEO_WORK_GOAL_ASKED, { goal: goal.goal })] : []),
    ...(goal.doneWhen ? [fillPrompt(NEO_WORK_GOAL_DONE_WHEN, { done_when: goal.doneWhen })] : []),
    ...(/merg/i.test(goal.doneWhen ?? '') ? [NEO_WORK_GOAL_MERGE] : []),
    NEO_WORK_GOAL_REMAINING,
  ].join('\n');
}

export function driverWorkCall(
  target: NeoDriverTarget,
  work: Pick<NeoWork, 'title' | 'instruction'>,
  goal: NeoWorkGoal | null = null
): { name: 'work.start' | 'work.send'; input: Record<string, unknown> } {
  const message = withWorkGoal(work.instruction, goal);
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
        },
      }
    : { name: 'work.send', input: { ref: target.ref, message } };
}

export function driverStartedReport(ref: WorkRef, link?: string, model?: string): string {
  const where = link ? ` It opens at ${link}.` : '';
  const runs = model ? ` It runs on ${model}.` : '';
  return `Handed to ${ref.adapter}${ref.daemon ? ` on ${ref.daemon}` : ''}.${runs}${where} Follow up with work.status ${JSON.stringify({ ref })}.`;
}

export function driverWorkCaller(work: Pick<NeoWork, 'originSessionId'>): OperationCaller {
  return { source: 'internal', sessionId: work.originSessionId, role: 'neo' };
}

export function readDriverOutcome(
  target: NeoDriverTarget,
  outcome: OperationOutcome
):
  | { ref: WorkRef; link?: string; model?: string; startedAt?: number; queued?: true }
  | { failure: string } {
  if (outcome.kind === 'failed') return { failure: outcome.message };
  const reply = DriverReplySchema.safeParse(outcome.value);
  if (!reply.success) return { failure: 'The work operation returned an unusable reply.' };
  if (!reply.data.ok) return { failure: `${reply.data.reason}: ${reply.data.detail}` };
  if ('ref' in reply.data.value) {
    const { ref, link, model, lastActivityAt } = reply.data.value as {
      ref: WorkRef;
      link?: unknown;
      model?: unknown;
      lastActivityAt?: unknown;
    };
    return {
      ref,
      ...(typeof link === 'string' ? { link } : {}),
      ...(typeof model === 'string' ? { model } : {}),
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
      })
      .passthrough(),
  }),
  z.object({ ok: z.literal(false), reason: z.string(), detail: z.string() }),
]);

type DriverStatusReply = z.infer<typeof DriverStatusSchema>;
type DriverStatus = Extract<DriverStatusReply, { ok: true }>['value'];

function parseDriverStatusReply(outcome: OperationOutcome): DriverStatusReply | null {
  if (outcome.kind !== 'completed') return null;
  const reply = DriverStatusSchema.safeParse(outcome.value);
  return reply.success ? reply.data : null;
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

export function readDriverSent(outcome: OperationOutcome, message: string): DriverSent | null {
  const inputs = readDriverInputs(outcome);
  const opening = messageOpening(message);
  if (!inputs || !opening) return null;
  return { inputBefore: Math.max(0, ...inputs.map((input) => input.at)), opening };
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

export const NEO_DRIVER_NO_REPLY = 'It finished without a written reply.';

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

export function neoAskChecklist(ask: NeoAsk): { id: string; text: string; state: string }[] {
  return (ask.doneItems ?? [])
    .filter((item) => !item.removed)
    .map(({ id, text, state }) => ({ id, text, state }));
}

export function driverDoneCheckNote(
  work: Pick<NeoWork, 'id' | 'title' | 'report' | 'originSessionId'>,
  goal: NeoWorkGoal,
  continued: number,
  budget: string | null,
  {
    prs,
    stale = false,
    ready = false,
    ask,
    cards = [],
  }: {
    prs?: readonly NeoWorkPr[];
    stale?: boolean;
    ready?: boolean;
    ask?: NeoAsk | null;
    cards?: readonly NeoAskCard[];
  } = {}
): string {
  const live = !prs
    ? ''
    : stale
      ? ` ${NEO_WORK_DONE_CHECK_PRS_STALE}`
      : ready
        ? ` ${NEO_WORK_DONE_CHECK_PRS_READY}`
        : ` ${NEO_WORK_DONE_CHECK_PRS_LIVE}`;
  const owned = !!ask && ask.originSessionId === work.originSessionId;
  const summary = owned
    ? fillPrompt(NEO_WORK_DONE_CHECK_ASK_NEXT, { summary: NEO_WORK_SUMMARY_NOTE })
    : NEO_WORK_SUMMARY_NOTE;
  const next = budget
    ? fillPrompt(NEO_WORK_DONE_CHECK_BUDGET, { budget, summary })
    : fillPrompt(NEO_WORK_DONE_CHECK_CONTINUE, {
        continues_left: String(NEO_WORK_CONTINUE_LIMIT - continued),
        summary,
      });
  const owner = !ask
    ? ''
    : owned
      ? ` ${fillPrompt(NEO_WORK_DONE_CHECK_ASK_OWNED, { ask_id: ask.id })}`
      : ` ${fillPrompt(NEO_WORK_DONE_CHECK_ASK_FOREIGN, { ask_id: ask.id })}`;
  return `${fillPrompt(NEO_WORK_DONE_CHECK, { prs: live, ask: owner, next })}\n${JSON.stringify({ workId: work.id, title: work.title, goal: goal.goal, doneWhen: goal.doneWhen, continued, report: work.report?.slice(0, 12000) ?? null, ...(prs ? { prs } : {}), ...(ask ? { ask: { id: ask.id, doneWhen: ask.doneWhen, status: ask.status, ...(owned ? { cards, items: neoAskChecklist(ask) } : {}) } } : {}) })}`;
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

export function readUnanchoredSettlement(
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

import {
  fillPrompt,
  NEO_WORK_BLOCKER,
  NEO_WORK_GOAL,
  NEO_WORK_GOAL_ASKED,
  NEO_WORK_GOAL_DONE_WHEN,
  NEO_WORK_GOAL_REMAINING,
} from '@hyperneo/prompts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { type NeoWorkGoal } from '@hyperneo/shared/types/neo-snapshot';
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
  WorkTurnEndSchema,
} from '../drivers/types.ts';
import { WORK_MESSAGE_MAX } from '../drivers/work-operations.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import type { OperationCaller } from '../operations/registry.ts';
import type { NeoSessionFacts } from './pack-contract.ts';
import { NeoReadWorkTarget } from './read-work.ts';

const NeoStartWorkTarget = z.object({
  verb: z.literal('start'),
  adapter: z.string().min(1).max(80),
  place: PlaceSchema.optional(),
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
  z.object({ verb: z.literal('bind'), ref: WorkRefSchema }),
]);

export type NeoTodoTarget = z.infer<typeof NeoTodoTargetSchema>;

export const NeoDriverTargetSchema = z.discriminatedUnion('verb', [
  NeoReadWorkTarget,
  NeoStartWorkTarget,
  NeoSendWorkTarget,
  z.object({ verb: z.literal('adopt'), ref: WorkRefSchema }),
]);

export type NeoDriverTarget = z.infer<typeof NeoDriverTargetSchema>;
const DriverReplySchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    value: z.union([z.object({ ref: WorkRefSchema }).passthrough(), WorkDeliverySchema]),
  }),
  z.object({ ok: z.literal(false), reason: z.string(), detail: z.string() }),
]);

export function withWorkGoal(
  instruction: string,
  goal: NeoWorkGoal | null,
  guidance: readonly string[] = []
): string {
  if (!goal?.goal && !goal?.doneWhen) return withTail(instruction, ['', NEO_WORK_BLOCKER]);
  return withTail(instruction, [
    '',
    NEO_WORK_GOAL,
    ...(goal.goal ? [fillPrompt(NEO_WORK_GOAL_ASKED, { goal: goal.goal })] : []),
    ...(goal.doneWhen ? [fillPrompt(NEO_WORK_GOAL_DONE_WHEN, { done_when: goal.doneWhen })] : []),
    ...guidance,
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
  formatGoal: (instruction: string, goal: NeoWorkGoal | null) => string = withWorkGoal
): { name: 'work.start' | 'work.send'; input: Record<string, unknown> } {
  const message = formatGoal(work.instruction, goal);
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
      delivery?: WorkDelivery;
    }
  | { failure: string; reason?: string } {
  if (outcome.kind === 'failed') return { failure: outcome.message };
  const reply = DriverReplySchema.safeParse(outcome.value);
  if (!reply.success) return { failure: 'The work operation returned an unusable reply.' };
  if (!reply.data.ok)
    return { failure: `${reply.data.reason}: ${reply.data.detail}`, reason: reply.data.reason };
  if ('ref' in reply.data.value) {
    const { ref, link, model, effort, lastActivityAt, receipt, status, watchHint } = reply.data
      .value as {
      ref: WorkRef;
      link?: unknown;
      model?: unknown;
      effort?: unknown;
      lastActivityAt?: unknown;
      receipt?: unknown;
      status?: unknown;
      watchHint?: unknown;
    };
    if (status === 'needs_you' && receipt === undefined)
      return {
        failure: typeof watchHint === 'string' ? watchHint : 'The new session needs the human.',
        reason: 'needs_you',
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
  const { delivered, receipt, confirmedAt, unconfirmed, queuedSubmissionId } = reply.data.value;
  const queued =
    delivered === false && (queuedSubmissionId !== undefined || !unconfirmed || !receipt);
  return {
    ref: target.ref,
    delivery: reply.data.value,
    ...(queued ? { queued: true as const } : {}),
    ...(delivered && confirmedAt !== undefined ? { startedAt: confirmedAt } : {}),
    ...(receipt ? { receipt } : {}),
  };
}

const DriverStatusSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    value: z
      .object({
        status: WorkStatusSchema,
        lastActivityAt: z.number(),
        lastReply: z.string().optional(),
        lastReplyAt: z.number().optional(),
        place: PlaceSchema.optional(),
        recentInputs: z.array(WorkInputSchema).optional(),
        exchange: z.array(WorkExchangeEntrySchema).optional(),
        exchangeCut: z.boolean().optional(),
        openedPrs: z.array(z.string()).optional(),
        linkedPrs: z
          .array(
            z.object({
              url: z.string(),
              dismissed: z.literal(true).optional(),
              own: z.literal(true).optional(),
            })
          )
          .optional(),
        linkedPrsWindow: z.literal(true).optional(),
        branches: z.array(z.string()).optional(),
        execution: z.object({ directory: z.string() }).passthrough().optional(),
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
  waitingFor?: string;
} | null {
  const value = parseDriverStatus(outcome);
  if (!value) return null;
  const { status, lastActivityAt, lastReplyAt, link, remoteLink, waitingFor } = value as {
    status: WorkStatus;
    lastActivityAt: number;
    lastReplyAt?: number;
    link?: unknown;
    remoteLink?: unknown;
    waitingFor?: unknown;
  };
  return {
    status,
    lastActivityAt,
    ...(lastReplyAt !== undefined ? { lastReplyAt } : {}),
    ...(typeof link === 'string' ? { link } : {}),
    ...(typeof remoteLink === 'string' ? { remoteLink } : {}),
    ...(typeof waitingFor === 'string' ? { waitingFor } : {}),
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
  delivery?: WorkDelivery;
  inputBefore: number;
  opening: string;
  receipt?: WorkDelivery['receipt'];
}

export function messageOpening(message: string): string {
  return message.trim().split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 80);
}

function readDriverInputs(outcome: OperationOutcome): WorkInput[] | null {
  return parseDriverStatus(outcome)?.recentInputs ?? null;
}

export function readDriverSessionFacts(
  outcome: OperationOutcome
): Omit<NeoSessionFacts, 'ref' | 'status' | 'lastActivityAt' | 'remotes'> | null {
  const value = parseDriverStatus(outcome);
  return value
    ? {
        ...(value.execution ? { folder: value.execution.directory } : {}),
        branches: value.branches ?? [],
        ...(value.linkedPrs ? { linkedPrs: value.linkedPrs } : {}),
        ...(value.linkedPrsWindow ? { linkedPrsWindow: true as const } : {}),
        openedPrs: value.openedPrs ?? [],
      }
    : null;
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

const NEO_DRIVER_NO_REPLY = 'It finished without a written reply.';

export function readDriverActivity(
  outcome: OperationOutcome
): { status: string; lastActivityAt: number; lastReply?: string } | null {
  const value = parseDriverStatus(outcome);
  if (!value) return null;
  const { status, lastActivityAt, lastReply } = value;
  return { status, lastActivityAt, lastReply };
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

type DriverInputAttribution =
  | {
      state: 'observed';
      replies: WorkExchangeEntry[];
      cut: boolean;
      replyAvailability?: 'complete' | 'incomplete';
      replyReport?: string;
      replyAt?: number;
    }
  | { state: 'pending' }
  | { state: 'unverified'; replyAvailability?: 'reply_unavailable' };

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
    return found.state === 'pending'
      ? { state: 'pending' }
      : {
          state: 'unverified',
          ...(found.replyAvailability ? { replyAvailability: found.replyAvailability } : {}),
        };
  return {
    state: 'observed',
    replies: found.exchange.filter((entry) => entry.role === 'agent'),
    cut: found.exchangeCut,
    ...(found.replyAvailability ? { replyAvailability: found.replyAvailability } : {}),
    ...(found.replyReport !== undefined ? { replyReport: found.replyReport } : {}),
    ...(found.replyAt !== undefined ? { replyAt: found.replyAt } : {}),
  };
}

export const NEO_WORK_LATER_REPLIES_CUT =
  '(Later replies were not read; this is not the whole exchange.)';

function attributedDriverReport(attribution: {
  replies: readonly WorkExchangeEntry[];
  cut: boolean;
  replyAvailability?: 'complete' | 'incomplete';
  replyReport?: string;
}): string | null {
  if (attribution.replyAvailability === 'incomplete')
    return 'Reply history is incomplete; the consumed turn has no verified terminal reply yet.';
  if (attribution.replyReport !== undefined) return attribution.replyReport;
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

export function readDriverTurnEnds(outcome: OperationOutcome) {
  const status = parseDriverStatus(outcome);
  const ends = z.array(WorkTurnEndSchema).safeParse(status?.turnEnds);
  return ends.success
    ? ends.data.map((turn) => ({ ...turn, senderMachine: status?.place?.machine }))
    : [];
}

export function readDriverFollowUp(
  outcome: OperationOutcome,
  since: number,
  sent: DriverSent | null = null
): string | null {
  const value = parseDriverStatus(outcome);
  if (!value || value.status === 'running' || value.status === 'queued') return null;
  const attribution = readDriverInputAttribution(outcome, sent?.receipt);
  if (
    attribution?.state === 'pending' ||
    (attribution?.state === 'unverified' && attribution.replyAvailability)
  )
    return null;
  if (attribution?.state === 'observed' && attribution.replyAvailability)
    return attribution.replyAvailability === 'complete' && (attribution.replyAt ?? 0) > since
      ? (attribution.replyReport ?? null)
      : null;
  if (attribution?.state === 'observed')
    return attributedDriverReport({
      ...attribution,
      replies: attribution.replies.filter((entry) => entry.at > since),
    });
  return null;
}

export function readDriverSettlement(
  _work: Pick<NeoWork, 'updatedAt'>,
  outcome: OperationOutcome,
  _now: number,
  _startedAt: number | null = null,
  _requireFresh = false,
  _opening: string | null = null,
  receipt?: WorkDelivery['receipt']
): { status: 'reported' | 'failed'; report: string } | null {
  const reply = parseDriverStatusReply(outcome);
  if (!reply) return null;
  if (!reply.ok) {
    return reply.reason === 'not_found'
      ? { status: 'failed', report: `The work is gone: ${reply.detail}` }
      : null;
  }
  const attribution = readDriverInputAttribution(outcome, receipt);
  return attribution && attribution.state !== 'unverified'
    ? settleAttributedDriverWork(reply.value.status, attribution)
    : null;
}

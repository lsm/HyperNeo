import superpipe, { type PipelineAPI } from 'superpipe';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import {
  buildDeferredEventDigestEnvelopeText,
  buildExternalEventDigestMessage,
  buildSyntheticExternalEventMessage,
  type ExternalEventEssenceEntry,
} from '../../external-events/deferred-event-digest.ts';
import { classifyExternalEventDirectSteer } from '../../external-events/event-tiers.ts';
import { type DirectSteerEventClass } from './external-event-steer-admission-pipeline.ts';

const DIRECT_STEER_TITLE = 'Direct external events while you were working (injected mid-turn)';

export type DirectSteerSkipReason =
  | 'session_not_tracked'
  | 'session_not_processing'
  | 'parent_task_limited'
  | 'no_deferred_rows'
  | 'no_direct_events';

export interface DirectSteerFlushSkip {
  action: 'skip';
  reason: DirectSteerSkipReason;
}

export interface DirectSteerFlushFailed {
  action: 'failed';
  stage: string;
  error: unknown;
}

export interface DirectSteerFlushDelivered {
  action: 'delivered';
  steerText: string;
  passengerText: string | null;
  steerDbId: string;
  sourceDbIds: string[];
  steerableCount: number;
  passengerCount: number;
  eventCount: number;
  steeredClasses: DirectSteerEventClass[];
  carriedDropped: number;
}

export type DirectSteerFlushOutcome =
  | DirectSteerFlushSkip
  | DirectSteerFlushFailed
  | DirectSteerFlushDelivered;

export interface DirectSteerBufferEntry {
  essences: ExternalEventEssenceEntry[];
  messageId: string;
  dbId: string;
  receivedAt: number;
  droppedEventCount?: number;
}

export interface DirectSteerFlushDeps {
  getSessionTracked(sessionId: string): boolean;
  getSessionProcessing(sessionId: string): boolean;
  isParentTaskLimited(sessionId: string): boolean;
  getDeferredUuids(sessionId: string): ReadonlySet<string>;
  savePassenger(sessionId: string, message: SDKUserMessage): Promise<string> | string;
  discardPassenger(sessionId: string, dbId: string | null): Promise<void> | void;
  saveSteer(sessionId: string, message: SDKUserMessage): Promise<string> | string;
  discardSteer(sessionId: string, messageId: string): Promise<void> | void;
  enqueueSteer(sessionId: string, messageId: string): void;
  consumeSources(sessionId: string, dbIds: string[]): void;
  recordHealthMetrics(steeredClasses: DirectSteerEventClass[]): void;
  publishStatusChanged(sessionId: string, dbId: string, status: string): Promise<void>;
  publishStatusesChanged(sessionId: string, dbIds: string[], status: string): Promise<void>;
}

export interface DirectSteerFlushInput {
  sessionId: string;
  entries: DirectSteerBufferEntry[];
  snippetMaxChars: number;
}

interface DirectSteerFlushCtx extends DirectSteerFlushInput {
  deps: DirectSteerFlushDeps;
  sessionTracked?: boolean;
  sessionProcessing?: boolean;
  parentTaskLimited?: boolean;
  deferredUuids?: ReadonlySet<string>;
  steerable?: DirectSteerBufferEntry[];
  steerEssences?: ExternalEventEssenceEntry[];
  passengerEssences?: ExternalEventEssenceEntry[];
  carriedDropped?: number;
  passengerText?: string | null;
  passengerMessage?: SDKUserMessage | null;
  passengerDbId?: string | null;
  steerText?: string;
  steerMessage?: SDKUserMessage;
  steerMessageId?: string;
  steerDbId?: string;
  outcome?: DirectSteerFlushOutcome;
}

function directSteerClassesOf(essences: ExternalEventEssenceEntry[]): DirectSteerEventClass[] {
  const classes = new Set<DirectSteerEventClass>();
  for (const essence of essences) {
    const eventClass = classifyExternalEventDirectSteer(essence);
    if (eventClass) classes.add(eventClass);
  }
  return [...classes];
}

function gatherState(ctx: DirectSteerFlushCtx): DirectSteerFlushCtx {
  return {
    ...ctx,
    sessionTracked: ctx.deps.getSessionTracked(ctx.sessionId),
    sessionProcessing: ctx.deps.getSessionProcessing(ctx.sessionId),
    parentTaskLimited: ctx.deps.isParentTaskLimited(ctx.sessionId),
    deferredUuids: ctx.deps.getDeferredUuids(ctx.sessionId),
  };
}

function claimSession(ctx: DirectSteerFlushCtx): DirectSteerFlushCtx {
  if (ctx.sessionTracked) return ctx;
  return { ...ctx, outcome: { action: 'skip', reason: 'session_not_tracked' } };
}

function checkSessionProcessing(ctx: DirectSteerFlushCtx): DirectSteerFlushCtx {
  if (ctx.sessionProcessing) return ctx;
  return { ...ctx, outcome: { action: 'skip', reason: 'session_not_processing' } };
}

function checkParentTaskLimited(ctx: DirectSteerFlushCtx): DirectSteerFlushCtx {
  if (!ctx.parentTaskLimited) return ctx;
  return { ...ctx, outcome: { action: 'skip', reason: 'parent_task_limited' } };
}

function filterSteerable(ctx: DirectSteerFlushCtx): DirectSteerFlushCtx {
  const steerable = ctx.entries.filter((entry) => ctx.deferredUuids?.has(entry.messageId));
  if (steerable.length === 0) {
    return { ...ctx, outcome: { action: 'skip', reason: 'no_deferred_rows' } };
  }
  const allEssences = steerable.flatMap((entry) => entry.essences);
  const steerEssences = allEssences.filter(
    (essence) => classifyExternalEventDirectSteer(essence) !== null
  );
  if (steerEssences.length === 0) {
    return { ...ctx, outcome: { action: 'skip', reason: 'no_direct_events' } };
  }
  const passengerEssences = allEssences.filter(
    (essence) => classifyExternalEventDirectSteer(essence) === null
  );
  const carriedDropped = steerable.reduce((sum, entry) => sum + (entry.droppedEventCount ?? 0), 0);
  return { ...ctx, steerable, steerEssences, passengerEssences, carriedDropped };
}

function buildPassengerText(ctx: DirectSteerFlushCtx): DirectSteerFlushCtx {
  const passengerEssences = ctx.passengerEssences ?? [];
  if (passengerEssences.length === 0) {
    return { ...ctx, passengerText: null, passengerMessage: null };
  }
  const carriedDropped = ctx.carriedDropped ?? 0;
  const text = buildDeferredEventDigestEnvelopeText(
    passengerEssences,
    carriedDropped > 0 ? { carriedDroppedCount: carriedDropped } : undefined
  );
  return {
    ...ctx,
    passengerText: text,
    passengerMessage: buildSyntheticExternalEventMessage(ctx.sessionId, text),
  };
}

function buildSteerText(ctx: DirectSteerFlushCtx): DirectSteerFlushCtx {
  const steerEssences = ctx.steerEssences ?? [];
  const carriedDropped = ctx.carriedDropped ?? 0;
  const steerText = buildExternalEventDigestMessage(steerEssences, {
    title: DIRECT_STEER_TITLE,
    snippetMaxChars: ctx.snippetMaxChars,
    renderAllReviewBodies: true,
    ...(ctx.passengerText || carriedDropped <= 0 ? {} : { droppedEventCount: carriedDropped }),
  });
  const steerMessage = buildSyntheticExternalEventMessage(ctx.sessionId, steerText);
  return {
    ...ctx,
    steerText,
    steerMessage,
    steerMessageId: String(steerMessage.uuid),
  };
}

async function persistPassenger(ctx: DirectSteerFlushCtx): Promise<DirectSteerFlushCtx> {
  if (!ctx.passengerMessage) {
    return { ...ctx, passengerDbId: null };
  }
  try {
    const passengerDbId = await ctx.deps.savePassenger(ctx.sessionId, ctx.passengerMessage);
    return { ...ctx, passengerDbId };
  } catch (error) {
    return { ...ctx, outcome: { action: 'failed', stage: 'persistPassenger', error } };
  }
}

async function reCheckSession(ctx: DirectSteerFlushCtx): Promise<DirectSteerFlushCtx> {
  if (ctx.deps.isParentTaskLimited(ctx.sessionId)) {
    await ctx.deps.discardPassenger(ctx.sessionId, ctx.passengerDbId ?? null);
    return { ...ctx, outcome: { action: 'skip', reason: 'parent_task_limited' } };
  }
  if (!ctx.deps.getSessionProcessing(ctx.sessionId)) {
    await ctx.deps.discardPassenger(ctx.sessionId, ctx.passengerDbId ?? null);
    return { ...ctx, outcome: { action: 'skip', reason: 'session_not_processing' } };
  }
  return ctx;
}

async function persistSteer(ctx: DirectSteerFlushCtx): Promise<DirectSteerFlushCtx> {
  try {
    const steerDbId = await ctx.deps.saveSteer(ctx.sessionId, ctx.steerMessage!);
    return { ...ctx, steerDbId };
  } catch (error) {
    await ctx.deps.discardPassenger(ctx.sessionId, ctx.passengerDbId ?? null);
    return { ...ctx, outcome: { action: 'failed', stage: 'persistSteer', error } };
  }
}

async function enqueueDelivery(ctx: DirectSteerFlushCtx): Promise<DirectSteerFlushCtx> {
  try {
    ctx.deps.enqueueSteer(ctx.sessionId, ctx.steerMessageId!);
    return ctx;
  } catch (error) {
    await ctx.deps.discardPassenger(ctx.sessionId, ctx.passengerDbId ?? null);
    await ctx.deps.discardSteer(ctx.sessionId, ctx.steerMessageId!);
    return { ...ctx, outcome: { action: 'failed', stage: 'enqueueDelivery', error } };
  }
}

async function commit(ctx: DirectSteerFlushCtx): Promise<DirectSteerFlushCtx> {
  const steerable = ctx.steerable ?? [];
  const steerEssences = ctx.steerEssences ?? [];
  const sourceDbIds = steerable.map((entry) => entry.dbId);
  const steeredClasses = directSteerClassesOf(steerEssences);
  const outcome: DirectSteerFlushDelivered = {
    action: 'delivered',
    steerText: ctx.steerText ?? '',
    passengerText: ctx.passengerText ?? null,
    steerDbId: ctx.steerDbId!,
    sourceDbIds,
    steerableCount: steerable.length,
    passengerCount: ctx.passengerEssences?.length ?? 0,
    eventCount: steerEssences.length,
    steeredClasses,
    carriedDropped: ctx.carriedDropped ?? 0,
  };
  ctx.deps.consumeSources(ctx.sessionId, sourceDbIds);
  ctx.deps.recordHealthMetrics(steeredClasses);
  await ctx.deps.publishStatusChanged(ctx.sessionId, ctx.steerDbId!, 'enqueued');
  await ctx.deps.publishStatusesChanged(ctx.sessionId, sourceDbIds, 'consumed');
  return { ...ctx, outcome };
}

async function rollback(ctx: DirectSteerFlushCtx): Promise<void> {
  await ctx.deps.discardPassenger(ctx.sessionId, ctx.passengerDbId ?? null);
  if (ctx.steerMessageId) {
    await ctx.deps.discardSteer(ctx.sessionId, ctx.steerMessageId);
  }
}

function hasOutcome(ctx: DirectSteerFlushCtx): boolean {
  return ctx.outcome !== undefined;
}

const run = (
  superpipe<{ hasOutcome: (ctx: DirectSteerFlushCtx) => boolean }>({
    hasOutcome,
  })('direct-steer-flush') as PipelineAPI
)
  .input(['ctx'])
  .pipe(gatherState, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(claimSession, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(checkSessionProcessing, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(checkParentTaskLimited, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(filterSteerable, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(buildPassengerText, 'ctx', 'ctx')
  .pipe(buildSteerText, 'ctx', 'ctx')
  .pipe(persistPassenger, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(reCheckSession, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(persistSteer, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(enqueueDelivery, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(commit, 'ctx', 'ctx')
  .error(rollback, ['ctx'])
  .endAsync('ctx') as (input: DirectSteerFlushCtx) => Promise<DirectSteerFlushCtx>;

export function runDirectSteerFlush(
  deps: DirectSteerFlushDeps,
  input: DirectSteerFlushInput
): Promise<DirectSteerFlushOutcome> {
  return run({ ...input, deps }).then(
    (ctx) =>
      ctx.outcome ?? { action: 'failed', stage: 'commit', error: new Error('missing outcome') }
  );
}

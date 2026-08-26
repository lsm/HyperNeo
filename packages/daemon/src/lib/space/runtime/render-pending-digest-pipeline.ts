import { createHash } from 'node:crypto';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  buildExternalEventDigestMessage,
  buildSyntheticExternalEventMessage,
  type ExternalEventEssenceEntry,
  parseDeferredExternalEventText,
} from '../../external-events/deferred-event-digest.ts';
import { formatExternalEventEssence } from '../../external-events/event-essence.ts';
import type {
  ExternalEventDeliveryRecord,
  ExternalEventRecord,
} from '../../external-events/types.ts';

export interface RenderPendingDigestTarget {
  workflowRunId: string;
  taskId: string;
  nodeId: string;
  agentName: string;
}

export interface RenderPendingDigestLedgerMark {
  eventId: string;
  deliveryKey: string;
}

export interface RenderPendingDigestDeps {
  listPendingDeliveries(target: RenderPendingDigestTarget): ExternalEventDeliveryRecord[];
  getEventById(eventId: string): ExternalEventRecord | null;
  findDigestByUuid(sessionId: string, uuid: string): Promise<{ dbId: string } | null>;
  saveDigestMessage(sessionId: string, message: SDKUserMessage): Promise<string>;
  appendDigest(sessionId: string, message: SDKUserMessage): Promise<boolean>;
  markDeliveriesDelivered(marks: RenderPendingDigestLedgerMark[]): void;
}

export interface RenderPendingDigestInput {
  sessionId: string;
  target: RenderPendingDigestTarget;
}

export type RenderPendingDigestSkipReason = 'no_pending_events' | 'no_renderable_events';

export interface RenderPendingDigestSkip {
  action: 'skip';
  reason: RenderPendingDigestSkipReason;
}

export interface RenderPendingDigestHeld {
  action: 'held';
  reason: 'mailbox_rejected' | 'append_error';
  uuid: string;
  dbId: string;
  error?: unknown;
}

export interface RenderPendingDigestFailed {
  action: 'failed';
  stage: string;
  error: unknown;
}

export interface RenderPendingDigestDelivered {
  action: 'delivered';
  uuid: string;
  dbId: string;
  text: string;
  eventIds: string[];
  deliveryKeys: string[];
  replayed: boolean;
}

export type RenderPendingDigestOutcome =
  | RenderPendingDigestSkip
  | RenderPendingDigestHeld
  | RenderPendingDigestFailed
  | RenderPendingDigestDelivered;

export interface RenderPendingDigestCtx extends RenderPendingDigestInput {
  deps: RenderPendingDigestDeps;
  pendingRows?: ExternalEventDeliveryRecord[];
  essences?: ExternalEventEssenceEntry[];
  digestText?: string;
  digestMessage?: SDKUserMessage;
  digestUuid?: string;
  digestDbId?: string;
  outcome?: RenderPendingDigestOutcome;
}

function eventRecordEssence(record: ExternalEventRecord): ExternalEventEssenceEntry | null {
  const event = record.event;
  const parsed = parseDeferredExternalEventText(
    formatExternalEventEssence({
      namespaceId: event.spaceId,
      spaceId: event.spaceId,
      eventId: event.id,
      source: event.source,
      topic: event.topic,
      dedupeKey: event.dedupeKey,
      summary: event.summary,
      externalUrl: event.externalUrl,
      payload: event.payload,
      occurredAt: event.occurredAt,
      ingestedAt: event.ingestedAt,
    })
  );
  return parsed && parsed.kind === 'event' ? parsed.essence : null;
}

export function loadPending(ctx: RenderPendingDigestCtx): RenderPendingDigestCtx {
  const pendingRows = ctx.deps.listPendingDeliveries(ctx.target);
  if (pendingRows.length === 0) {
    return { ...ctx, outcome: { action: 'skip', reason: 'no_pending_events' } };
  }
  const essences: ExternalEventEssenceEntry[] = [];
  for (const row of pendingRows) {
    const record = ctx.deps.getEventById(row.eventId);
    const essence = record ? eventRecordEssence(record) : null;
    if (essence) essences.push(essence);
  }
  return { ...ctx, pendingRows, essences };
}

export function orderAndDedupe(ctx: RenderPendingDigestCtx): RenderPendingDigestCtx {
  const essences = ctx.essences ?? [];
  if (essences.length === 0) {
    return { ...ctx, outcome: { action: 'skip', reason: 'no_renderable_events' } };
  }
  const byEventId = new Map<string, ExternalEventEssenceEntry>();
  for (const essence of essences) byEventId.set(essence.eventId, essence);
  const ordered = [...byEventId.keys()].sort().map((eventId) => byEventId.get(eventId)!);
  return { ...ctx, essences: ordered };
}

export function aggregateRender(ctx: RenderPendingDigestCtx): RenderPendingDigestCtx {
  return { ...ctx, digestText: buildExternalEventDigestMessage(ctx.essences ?? []) };
}

function deterministicDigestUuid(eventIds: string[]): string {
  const digest = createHash('sha256')
    .update([...eventIds].sort().join('\u0000'))
    .digest('hex');
  return `digest-${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(
    16,
    20
  )}-${digest.slice(20, 32)}`;
}

export function buildMessage(ctx: RenderPendingDigestCtx): RenderPendingDigestCtx {
  const eventIds = (ctx.essences ?? []).map((essence) => essence.eventId);
  const digestUuid = deterministicDigestUuid(eventIds);
  const digestMessage = buildSyntheticExternalEventMessage(
    ctx.sessionId,
    ctx.digestText ?? '',
    digestUuid
  );
  return { ...ctx, digestUuid, digestMessage };
}

export async function persistAndAppend(
  ctx: RenderPendingDigestCtx
): Promise<RenderPendingDigestCtx> {
  const message = ctx.digestMessage!;
  const uuid = ctx.digestUuid!;
  let dbId: string;
  let replayed: boolean;
  try {
    const existing = await ctx.deps.findDigestByUuid(ctx.sessionId, uuid);
    if (existing) {
      dbId = existing.dbId;
      replayed = true;
    } else {
      dbId = await ctx.deps.saveDigestMessage(ctx.sessionId, message);
      replayed = false;
    }
  } catch (error) {
    return { ...ctx, outcome: { action: 'failed', stage: 'persistDigest', error } };
  }
  let accepted: boolean;
  try {
    accepted = await ctx.deps.appendDigest(ctx.sessionId, message);
  } catch (error) {
    return {
      ...ctx,
      digestDbId: dbId,
      outcome: { action: 'held', reason: 'append_error', uuid, dbId, error },
    };
  }
  if (!accepted) {
    return {
      ...ctx,
      digestDbId: dbId,
      outcome: { action: 'held', reason: 'mailbox_rejected', uuid, dbId },
    };
  }
  const renderedEventIds = new Set((ctx.essences ?? []).map((essence) => essence.eventId));
  const marks = (ctx.pendingRows ?? [])
    .filter((row) => renderedEventIds.has(row.eventId))
    .map((row) => ({ eventId: row.eventId, deliveryKey: row.deliveryKey }));
  if (marks.length > 0) {
    try {
      ctx.deps.markDeliveriesDelivered(marks);
    } catch (error) {
      return { ...ctx, outcome: { action: 'failed', stage: 'markDeliveries', error } };
    }
  }
  return {
    ...ctx,
    digestDbId: dbId,
    outcome: {
      action: 'delivered',
      uuid,
      dbId,
      text: ctx.digestText ?? '',
      eventIds: (ctx.essences ?? []).map((essence) => essence.eventId),
      deliveryKeys: marks.map((mark) => mark.deliveryKey),
      replayed,
    },
  };
}

function hasOutcome(ctx: RenderPendingDigestCtx): boolean {
  return ctx.outcome !== undefined;
}

const run = (
  superpipe<{ hasOutcome: (ctx: RenderPendingDigestCtx) => boolean }>({
    hasOutcome,
  })('render-pending-digest') as PipelineAPI
)
  .input(['ctx'])
  .pipe(loadPending, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(orderAndDedupe, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(aggregateRender, 'ctx', 'ctx')
  .pipe(buildMessage, 'ctx', 'ctx')
  .pipe(persistAndAppend, 'ctx', 'ctx')
  .endAsync('ctx') as (input: RenderPendingDigestCtx) => Promise<RenderPendingDigestCtx>;

export function runRenderPendingDigest(
  deps: RenderPendingDigestDeps,
  input: RenderPendingDigestInput
): Promise<RenderPendingDigestOutcome> {
  return run({ ...input, deps }).then(
    (ctx) =>
      ctx.outcome ?? {
        action: 'failed',
        stage: 'persistAndAppend',
        error: new Error('missing outcome'),
      }
  );
}

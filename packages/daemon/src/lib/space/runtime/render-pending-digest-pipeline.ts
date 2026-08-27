import { createHash } from 'node:crypto';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  buildExternalEventDigestMessage,
  buildSyntheticExternalEventMessage,
  deferredExternalEventEntryEvents,
  type ExternalEventEssenceEntry,
  parseDeferredDeliveryRow,
  parseDeferredExternalEventText,
} from '../../external-events/deferred-event-digest.ts';
import { formatExternalEventEssence } from '../../external-events/event-essence.ts';
import type {
  ExternalEventDeliveryRecord,
  ExternalEventRecord,
} from '../../external-events/types.ts';
import { isQueuedExternalEventExpired } from './external-event-admission-gates.ts';
import { buildImmediateEventMessageUuid } from './immediate-event-delivery-pipeline.ts';

export interface RenderPendingDigestTarget {
  workflowRunId: string;
  taskId: string;
  nodeId: string;
  agentName: string;
}

export interface RenderPendingDigestScope {
  workflowRunId: string;
  taskId?: string;
  nodeId: string;
  agentName: string;
}

export interface TurnEndExecutionRef {
  workflowRunId: string;
  workflowNodeId: string;
  agentName: string;
}

export type TurnEndDeliveryTerminalReason =
  | 'ttl_expired'
  | 'subscription_no_longer_active'
  | 'task_terminal';

export interface RenderPendingDigestLedgerMark {
  eventId: string;
  deliveryKey: string;
}

export interface RenderPendingDigestSavedDigest {
  dbId: string;
  replayed: boolean;
}

export type LegacyDurableScanStatus = 'deferred' | 'enqueued' | 'submitted';

export interface RenderPendingDigestDeps {
  getExecutionByAgentSessionId(sessionId: string): TurnEndExecutionRef | null;
  listPendingDeliveries(scope: RenderPendingDigestScope): ExternalEventDeliveryRecord[];
  ownsCurrentExecution(target: RenderPendingDigestTarget, sessionId: string): boolean;
  isTaskAdmissible(taskId: string): boolean;
  isTaskTerminal(taskId: string): boolean;
  isSpacePaused(workflowRunId: string): boolean;
  listUserMessagesByStatus(
    sessionId: string,
    status: LegacyDurableScanStatus | 'consumed'
  ): SDKUserMessage[];
  listUserMessagesByUuidPrefix(
    sessionId: string,
    prefix: string
  ): Array<SDKUserMessage & { sendStatus?: string | null }>;
  getDeliveryContent(sessionId: string, uuid: string): unknown;
  isDeliveryInFlight(deliveryKey: string): boolean;
  acquireDeliveryClaims(deliveryKeys: string[]): void;
  releaseDeliveryClaims(deliveryKeys: string[]): void;
  now(): number;
  queueTtlMs: number;
  isTargetStillSubscribed(target: RenderPendingDigestTarget, topic: string): boolean;
  failDeliveryTerminal(
    target: RenderPendingDigestTarget,
    eventId: string,
    deliveryKey: string,
    reason: TurnEndDeliveryTerminalReason
  ): void;
  getEventById(eventId: string): ExternalEventRecord | null;
  saveDigestMessageIfAbsent(
    sessionId: string,
    message: SDKUserMessage
  ): Promise<RenderPendingDigestSavedDigest>;
  appendDigest(sessionId: string, message: SDKUserMessage): Promise<boolean>;
  markDeliveriesDelivered(
    target: RenderPendingDigestTarget,
    marks: RenderPendingDigestLedgerMark[]
  ): void;
}

export interface RenderPendingDigestInput {
  sessionId: string;
  taskId?: string;
}

export type RenderPendingDigestSkipReason =
  | 'no_execution'
  | 'no_pending_events'
  | 'session_not_current'
  | 'task_not_admissible'
  | 'space_paused'
  | 'no_claimable_events'
  | 'no_renderable_events';

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
  execution?: TurnEndExecutionRef;
  scopedRows?: ExternalEventDeliveryRecord[];
  target?: RenderPendingDigestTarget;
  legacyDurableEventIds?: Set<string>;
  consumedDurableEventIds?: Set<string>;
  replayDigestMessage?: SDKUserMessage;
  replayEventIds?: Set<string>;
  digestMembershipEventIds?: Set<string>;
  replayable?: boolean;
  pendingRows?: ExternalEventDeliveryRecord[];
  essences?: ExternalEventEssenceEntry[];
  digestText?: string;
  digestMessage?: SDKUserMessage;
  digestUuid?: string;
  digestDbId?: string;
  outcome?: RenderPendingDigestOutcome;
}

export const TURN_END_DIGEST_PENDING_ROW_CAP = 200;

export const TURN_END_DIGEST_SCAN_ROW_CAP = TURN_END_DIGEST_PENDING_ROW_CAP * 4;

export const LEGACY_DURABLE_SCAN_STATUSES = ['deferred', 'enqueued', 'submitted'] as const;

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

export function resolveTarget(ctx: RenderPendingDigestCtx): RenderPendingDigestCtx {
  const execution = ctx.deps.getExecutionByAgentSessionId(ctx.sessionId);
  if (!execution) {
    return { ...ctx, outcome: { action: 'skip', reason: 'no_execution' } };
  }
  const scopedRows = ctx.deps.listPendingDeliveries({
    workflowRunId: execution.workflowRunId,
    taskId: ctx.taskId,
    nodeId: execution.workflowNodeId,
    agentName: execution.agentName,
  });
  if (scopedRows.length === 0) {
    return { ...ctx, outcome: { action: 'skip', reason: 'no_pending_events' } };
  }
  const fallbackTaskId = ctx.taskId ?? scopedRows[0].taskId;
  const targetScopedRows = ctx.taskId
    ? scopedRows
    : scopedRows.filter((row) => row.taskId === fallbackTaskId);
  const target: RenderPendingDigestTarget = {
    workflowRunId: execution.workflowRunId,
    taskId: fallbackTaskId,
    nodeId: execution.workflowNodeId,
    agentName: execution.agentName,
  };
  return { ...ctx, execution, scopedRows: targetScopedRows, target };
}

export function admitTurnEnd(ctx: RenderPendingDigestCtx): RenderPendingDigestCtx {
  const target = ctx.target!;
  if (!ctx.deps.ownsCurrentExecution(target, ctx.sessionId)) {
    return { ...ctx, outcome: { action: 'skip', reason: 'session_not_current' } };
  }
  if (!ctx.deps.isTaskAdmissible(target.taskId)) {
    if (ctx.deps.isTaskTerminal(target.taskId)) {
      for (const row of ctx.scopedRows ?? []) {
        ctx.deps.failDeliveryTerminal(target, row.eventId, row.deliveryKey, 'task_terminal');
      }
    }
    return { ...ctx, outcome: { action: 'skip', reason: 'task_not_admissible' } };
  }
  if (ctx.deps.isSpacePaused(target.workflowRunId)) {
    return { ...ctx, outcome: { action: 'skip', reason: 'space_paused' } };
  }
  return ctx;
}

function durableRowEventIds(rows: SDKUserMessage[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    const entry = parseDeferredDeliveryRow(row);
    if (!entry) continue;
    for (const event of deferredExternalEventEntryEvents(entry)) ids.push(event.eventId);
  }
  return ids;
}

export function reconcileDurable(ctx: RenderPendingDigestCtx): RenderPendingDigestCtx {
  const legacyDurableEventIds = new Set<string>();
  for (const status of LEGACY_DURABLE_SCAN_STATUSES) {
    const rows = ctx.deps.listUserMessagesByStatus(ctx.sessionId, status);
    for (const eventId of durableRowEventIds(rows)) legacyDurableEventIds.add(eventId);
  }
  const consumedDurableEventIds = new Set(
    durableRowEventIds(ctx.deps.listUserMessagesByStatus(ctx.sessionId, 'consumed'))
  );
  const digestMembershipRows: Array<{ message: SDKUserMessage; eventIds: Set<string> }> = [];
  const digestMembershipEventIds = new Set<string>();
  for (const row of ctx.deps.listUserMessagesByUuidPrefix(
    ctx.sessionId,
    DETERMINISTIC_DIGEST_UUID_PREFIX
  )) {
    const membership = (row as { externalEventIds?: unknown }).externalEventIds;
    if (!Array.isArray(membership) || membership.length === 0) continue;
    const ids = new Set(membership.filter((id): id is string => typeof id === 'string'));
    if (row.sendStatus === 'consumed') {
      for (const eventId of ids) consumedDurableEventIds.add(eventId);
      continue;
    }
    digestMembershipRows.push({ message: row, eventIds: ids });
    for (const eventId of ids) digestMembershipEventIds.add(eventId);
  }
  const candidateRows = (ctx.scopedRows ?? []).slice(0, TURN_END_DIGEST_SCAN_ROW_CAP);
  const pendingEventIdSet = new Set(
    candidateRows
      .filter((row) => ctx.deps.getEventById(row.eventId) !== null)
      .map((row) => row.eventId)
  );
  const replayMatch = digestMembershipRows.find(({ eventIds }) =>
    [...pendingEventIdSet].every((id) => eventIds.has(id))
  );
  const replayable = pendingEventIdSet.size > 0 && replayMatch !== undefined;
  return {
    ...ctx,
    legacyDurableEventIds,
    consumedDurableEventIds,
    digestMembershipEventIds,
    replayDigestMessage: replayMatch?.message,
    replayEventIds: replayable ? pendingEventIdSet : undefined,
    replayable,
  };
}

function rowTerminalReason(
  ctx: RenderPendingDigestCtx,
  target: RenderPendingDigestTarget,
  row: ExternalEventDeliveryRecord
): TurnEndDeliveryTerminalReason | null {
  const record = ctx.deps.getEventById(row.eventId);
  if (!record) return null;
  if (isQueuedExternalEventExpired(record.createdAt, ctx.deps.now(), ctx.deps.queueTtlMs)) {
    return 'ttl_expired';
  }
  if (!ctx.deps.isTargetStillSubscribed(target, record.event.topic)) {
    return 'subscription_no_longer_active';
  }
  return null;
}

export function claimPending(ctx: RenderPendingDigestCtx): RenderPendingDigestCtx {
  const target = ctx.target!;
  const claimed: ExternalEventDeliveryRecord[] = [];
  const consumedMarks: RenderPendingDigestLedgerMark[] = [];
  const candidateRows = (ctx.scopedRows ?? []).slice(0, TURN_END_DIGEST_SCAN_ROW_CAP);
  for (const row of candidateRows) {
    if (claimed.length >= TURN_END_DIGEST_PENDING_ROW_CAP) break;
    if (ctx.deps.isDeliveryInFlight(row.deliveryKey)) continue;
    if (ctx.consumedDurableEventIds?.has(row.eventId)) {
      consumedMarks.push({ eventId: row.eventId, deliveryKey: row.deliveryKey });
      continue;
    }
    if (ctx.legacyDurableEventIds?.has(row.eventId)) continue;
    if (!ctx.replayable && ctx.digestMembershipEventIds?.has(row.eventId)) continue;
    const immediate = ctx.deps.getDeliveryContent(
      ctx.sessionId,
      buildImmediateEventMessageUuid(row.eventId, row.deliveryKey)
    );
    if (immediate && (immediate as { sendStatus?: unknown }).sendStatus !== 'failed') {
      continue;
    }
    const reason = rowTerminalReason(ctx, target, row);
    if (reason) {
      ctx.deps.failDeliveryTerminal(target, row.eventId, row.deliveryKey, reason);
      continue;
    }
    claimed.push(row);
  }
  if (consumedMarks.length > 0) {
    try {
      ctx.deps.markDeliveriesDelivered(target, consumedMarks);
    } catch (error) {
      return { ...ctx, outcome: { action: 'failed', stage: 'markConsumedDelivered', error } };
    }
  }
  if (claimed.length === 0) {
    return { ...ctx, outcome: { action: 'skip', reason: 'no_claimable_events' } };
  }
  ctx.deps.acquireDeliveryClaims(claimed.map((row) => row.deliveryKey));
  return { ...ctx, pendingRows: claimed };
}

export function loadPending(ctx: RenderPendingDigestCtx): RenderPendingDigestCtx {
  const pendingRows = ctx.pendingRows ?? [];
  if (pendingRows.length === 0) {
    return { ...ctx, outcome: { action: 'skip', reason: 'no_pending_events' } };
  }
  const essences: ExternalEventEssenceEntry[] = [];
  for (const row of pendingRows) {
    const record = ctx.deps.getEventById(row.eventId);
    const essence = record ? eventRecordEssence(record) : null;
    if (essence) essences.push(essence);
  }
  return { ...ctx, essences };
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

export const DETERMINISTIC_DIGEST_UUID_PREFIX = 'digest-';

function deterministicDigestUuid(eventIds: string[]): string {
  const digest = createHash('sha256')
    .update([...eventIds].sort().join('\u0000'))
    .digest('hex');
  return `${DETERMINISTIC_DIGEST_UUID_PREFIX}${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function syntheticMessageText(message: SDKUserMessage): string {
  const content = message.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((block) => (block as { type?: string }).type === 'text') as
      | { text?: unknown }
      | undefined;
    if (textBlock) return String(textBlock.text ?? '');
  }
  return '';
}

export function buildMessage(ctx: RenderPendingDigestCtx): RenderPendingDigestCtx {
  if (ctx.replayable && ctx.replayDigestMessage && ctx.replayEventIds) {
    const current = (ctx.essences ?? []).map((essence) => essence.eventId).sort();
    const matched = [...ctx.replayEventIds].sort();
    if (current.length === matched.length && current.every((id, index) => id === matched[index])) {
      return {
        ...ctx,
        digestUuid: String(ctx.replayDigestMessage.uuid),
        digestMessage: ctx.replayDigestMessage,
        digestText: syntheticMessageText(ctx.replayDigestMessage),
      };
    }
  }
  const eventIds = (ctx.essences ?? []).map((essence) => essence.eventId).sort();
  const digestUuid = deterministicDigestUuid(eventIds);
  const digestMessage = {
    ...buildSyntheticExternalEventMessage(ctx.sessionId, ctx.digestText ?? '', digestUuid),
    externalEventIds: eventIds,
  } as SDKUserMessage;
  return { ...ctx, digestUuid, digestMessage };
}

export async function persistAndAppend(
  ctx: RenderPendingDigestCtx
): Promise<RenderPendingDigestCtx> {
  const message = ctx.digestMessage!;
  const uuid = ctx.digestUuid!;
  let saved: RenderPendingDigestSavedDigest;
  try {
    saved = await ctx.deps.saveDigestMessageIfAbsent(ctx.sessionId, message);
  } catch (error) {
    return { ...ctx, outcome: { action: 'failed', stage: 'persistDigest', error } };
  }
  const dbId = saved.dbId;
  const rechecked = admitTurnEnd(ctx);
  if (rechecked.outcome) {
    return { ...ctx, digestDbId: dbId, outcome: rechecked.outcome };
  }
  const target = ctx.target!;
  const survivingRows: ExternalEventDeliveryRecord[] = [];
  for (const row of ctx.pendingRows ?? []) {
    const reason = rowTerminalReason(ctx, target, row);
    if (reason) {
      ctx.deps.failDeliveryTerminal(target, row.eventId, row.deliveryKey, reason);
      continue;
    }
    survivingRows.push(row);
  }
  if (survivingRows.length === 0) {
    return { ...ctx, digestDbId: dbId, outcome: { action: 'skip', reason: 'no_claimable_events' } };
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
  const marks = survivingRows
    .filter((row) => renderedEventIds.has(row.eventId))
    .map((row) => ({ eventId: row.eventId, deliveryKey: row.deliveryKey }));
  if (marks.length > 0) {
    try {
      ctx.deps.markDeliveriesDelivered(ctx.target!, marks);
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
      replayed: saved.replayed,
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
  .pipe(resolveTarget, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(admitTurnEnd, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(reconcileDurable, 'ctx', 'ctx')
  .pipe(claimPending, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
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
  const claimedDeliveryKeys: string[] = [];
  const claimingDeps: RenderPendingDigestDeps = {
    ...deps,
    acquireDeliveryClaims: (deliveryKeys) => {
      claimedDeliveryKeys.push(...deliveryKeys);
      deps.acquireDeliveryClaims(deliveryKeys);
    },
  };
  return run({ ...input, deps: claimingDeps })
    .then(
      (ctx) =>
        ctx.outcome ?? {
          action: 'failed' as const,
          stage: 'persistAndAppend',
          error: new Error('missing outcome'),
        }
    )
    .finally(() => {
      if (claimedDeliveryKeys.length > 0) deps.releaseDeliveryClaims(claimedDeliveryKeys);
    });
}

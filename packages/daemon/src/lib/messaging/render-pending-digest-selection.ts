import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { ExternalEventEssenceEntry } from '../external-events/deferred-event-digest.ts';
import { essenceEntryFromExternalEvent } from '../external-events/event-essence-entry.ts';
import type { ExternalEventDeliveryRecord, ExternalEventRecord } from '../external-events/types.ts';
import { isQueuedExternalEventExpired } from '../space/runtime/external-event-admission-gates.ts';
import { buildImmediateEventMessageUuid } from '../space/runtime/immediate-event-delivery-pipeline.ts';
import { DETERMINISTIC_DIGEST_UUID_PREFIX } from './render-pending-digest-rendering.ts';
import {
  type RenderPendingDigestCtx,
  type RenderPendingDigestLedgerMark,
  type RenderPendingDigestTarget,
  TURN_END_DIGEST_PENDING_ROW_CAP,
  TURN_END_DIGEST_SCAN_ROW_CAP,
  type TurnEndDeliveryTerminalReason,
  type TurnEndExecutionRef,
} from './render-pending-digest-types.ts';

function eventRecordEssence(record: ExternalEventRecord): ExternalEventEssenceEntry | null {
  return essenceEntryFromExternalEvent(record.event);
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
    const admissionSkip = skipWhenInadmissible(ctx, execution);
    if (admissionSkip) return admissionSkip;
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

function skipWhenInadmissible(
  ctx: RenderPendingDigestCtx,
  execution: TurnEndExecutionRef
): RenderPendingDigestCtx | null {
  const target: RenderPendingDigestTarget = {
    workflowRunId: execution.workflowRunId,
    taskId: ctx.taskId ?? '',
    nodeId: execution.workflowNodeId,
    agentName: execution.agentName,
  };
  if (!ctx.deps.ownsCurrentExecution(target, ctx.sessionId)) {
    return { ...ctx, outcome: { action: 'skip', reason: 'session_not_current' } };
  }
  if (ctx.taskId !== undefined && !ctx.deps.isTaskAdmissible(ctx.taskId)) {
    return { ...ctx, outcome: { action: 'skip', reason: 'task_not_admissible' } };
  }
  if (ctx.deps.isSpacePaused(execution.workflowRunId)) {
    return { ...ctx, outcome: { action: 'skip', reason: 'space_paused' } };
  }
  if (ctx.deps.isSessionInterruptInProgress(ctx.sessionId)) {
    return { ...ctx, outcome: { action: 'skip', reason: 'session_interrupted' } };
  }
  return null;
}

export function admitTurnEnd(ctx: RenderPendingDigestCtx): RenderPendingDigestCtx {
  const target = ctx.target!;
  if (!ctx.deps.ownsCurrentExecution(target, ctx.sessionId)) {
    return { ...ctx, outcome: { action: 'skip', reason: 'session_not_current' } };
  }
  if (!ctx.deps.isTaskAdmissible(target.taskId)) {
    if (ctx.deps.isTaskTerminal(target.taskId)) {
      const consumedDurableEventIds = ctx.consumedDurableEventIds ?? collectConsumedEvidence(ctx);
      const consumedMarks: RenderPendingDigestLedgerMark[] = [];
      const failRows: ExternalEventDeliveryRecord[] = [];
      for (const row of ctx.scopedRows ?? []) {
        if (consumedDurableEventIds.has(row.eventId)) {
          consumedMarks.push({ eventId: row.eventId, deliveryKey: row.deliveryKey });
        } else {
          failRows.push(row);
        }
      }
      if (consumedMarks.length > 0) {
        try {
          ctx.deps.markDeliveriesDelivered(target, consumedMarks);
        } catch (error) {
          return { ...ctx, outcome: { action: 'failed', stage: 'markConsumedDelivered', error } };
        }
      }
      for (const row of failRows) {
        ctx.deps.failDeliveryTerminal(target, row.eventId, row.deliveryKey, 'task_terminal');
      }
    }
    return { ...ctx, outcome: { action: 'skip', reason: 'task_not_admissible' } };
  }
  if (ctx.deps.isSpacePaused(target.workflowRunId)) {
    return { ...ctx, outcome: { action: 'skip', reason: 'space_paused' } };
  }
  if (ctx.deps.isSessionInterruptInProgress(ctx.sessionId)) {
    return { ...ctx, outcome: { action: 'skip', reason: 'session_interrupted' } };
  }
  return ctx;
}

function collectConsumedEvidence(ctx: RenderPendingDigestCtx): Set<string> {
  const ids = new Set<string>();
  for (const row of ctx.deps.listUserMessagesByUuidPrefix(
    ctx.sessionId,
    DETERMINISTIC_DIGEST_UUID_PREFIX
  )) {
    if (row.sendStatus !== 'consumed') continue;
    const membership = (row as { externalEventIds?: unknown }).externalEventIds;
    if (!Array.isArray(membership)) continue;
    for (const eventId of membership) {
      if (typeof eventId === 'string') ids.add(eventId);
    }
  }
  return ids;
}

export function reconcileDurable(ctx: RenderPendingDigestCtx): RenderPendingDigestCtx {
  const consumedDurableEventIds = ctx.consumedDurableEventIds ?? new Set<string>();
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
    if (row.sendStatus === 'enqueued' || row.sendStatus === 'submitted') {
      for (const eventId of ids) digestMembershipEventIds.add(eventId);
      continue;
    }
    digestMembershipRows.push({ message: row, eventIds: ids });
  }
  const candidateRows = (ctx.scopedRows ?? []).slice(0, TURN_END_DIGEST_SCAN_ROW_CAP);
  const pendingEventIdSet = new Set(
    candidateRows
      .filter((row) => ctx.deps.getEventById(row.eventId) !== null)
      .map((row) => row.eventId)
      .filter((id) => !digestMembershipEventIds.has(id))
  );
  const replayMatch = digestMembershipRows.find(
    ({ eventIds }) =>
      eventIds.size === pendingEventIdSet.size &&
      [...pendingEventIdSet].every((id) => eventIds.has(id))
  );
  const replayable = pendingEventIdSet.size > 0 && replayMatch !== undefined;
  return {
    ...ctx,
    consumedDurableEventIds,
    digestMembershipEventIds,
    replayDigestMessage: replayMatch?.message,
    replayEventIds: replayable ? pendingEventIdSet : undefined,
    replayable,
  };
}

export function rowTerminalReason(
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
  let heldDigestInFlight = false;
  const candidateRows = (ctx.scopedRows ?? []).slice(0, TURN_END_DIGEST_SCAN_ROW_CAP);
  for (const row of candidateRows) {
    if (claimed.length >= TURN_END_DIGEST_PENDING_ROW_CAP) break;
    if (ctx.deps.isDeliveryInFlight(row.deliveryKey)) continue;
    if (ctx.consumedDurableEventIds?.has(row.eventId)) {
      consumedMarks.push({ eventId: row.eventId, deliveryKey: row.deliveryKey });
      continue;
    }
    if (ctx.digestMembershipEventIds?.has(row.eventId)) {
      heldDigestInFlight = true;
      continue;
    }
    const immediate = ctx.deps.getDeliveryContent(
      ctx.sessionId,
      buildImmediateEventMessageUuid(row.eventId, row.deliveryKey)
    );
    const immediateStatus = immediate
      ? (immediate as { sendStatus?: unknown }).sendStatus
      : undefined;
    if (immediate && immediateStatus !== 'failed') {
      if (immediateStatus === 'consumed') {
        consumedMarks.push({ eventId: row.eventId, deliveryKey: row.deliveryKey });
      }
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
    return {
      ...ctx,
      outcome: heldDigestInFlight
        ? { action: 'skip', reason: 'no_claimable_events', heldDigestInFlight: true }
        : { action: 'skip', reason: 'no_claimable_events' },
    };
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

import superpipe, { type PipelineAPI } from 'superpipe';
import type { ExternalEventDeliveryRecord } from '../external-events/types.ts';
import {
  aggregateRender,
  buildMessage,
  capDigestBatch,
  orderAndDedupe,
} from './render-pending-digest-rendering.ts';
import {
  admitTurnEnd,
  claimPending,
  loadPending,
  reconcileDurable,
  resolveTarget,
  rowTerminalReason,
} from './render-pending-digest-selection.ts';
import type {
  RenderPendingDigestCtx,
  RenderPendingDigestDeps,
  RenderPendingDigestInput,
  RenderPendingDigestOutcome,
  RenderPendingDigestSavedDigest,
} from './render-pending-digest-types.ts';

export { DETERMINISTIC_DIGEST_UUID_PREFIX } from './render-pending-digest-rendering.ts';
export type {
  RenderPendingDigestDeps,
  RenderPendingDigestOutcome,
} from './render-pending-digest-types.ts';

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
  const renderedEventIds = new Set((ctx.essences ?? []).map((essence) => essence.eventId));
  const survivingRows: ExternalEventDeliveryRecord[] = [];
  let droppedRendered = false;
  for (const row of ctx.pendingRows ?? []) {
    const reason = rowTerminalReason(ctx, target, row);
    if (reason) {
      ctx.deps.failDeliveryTerminal(target, row.eventId, row.deliveryKey, reason);
      if (renderedEventIds.has(row.eventId)) droppedRendered = true;
      continue;
    }
    survivingRows.push(row);
  }
  if (droppedRendered || survivingRows.length === 0) {
    return { ...ctx, digestDbId: dbId, outcome: { action: 'skip', reason: 'no_claimable_events' } };
  }
  if (saved.replayed) {
    try {
      ctx.deps.reopenFailedDigest(ctx.sessionId, uuid);
    } catch (error) {
      return { ...ctx, outcome: { action: 'failed', stage: 'reopenFailedDigest', error } };
    }
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
  if (ctx.deps.isSessionInterruptInProgress(ctx.sessionId)) {
    if (!saved.replayed) {
      try {
        ctx.deps.deleteDigestMessage(ctx.sessionId, dbId);
      } catch (error) {
        return { ...ctx, outcome: { action: 'failed', stage: 'digestCleanup', error } };
      }
    }
    return {
      ...ctx,
      digestDbId: dbId,
      outcome: { action: 'skip', reason: 'session_interrupted' },
    };
  }
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
      taskId: ctx.target!.taskId,
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
  .pipe(capDigestBatch, 'ctx', 'ctx')
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

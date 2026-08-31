import superpipe, { type PipelineAPI } from 'superpipe';
import { decidePendingDrainAdmission } from './pending-drain-decision-pipeline.ts';
import type { PendingAgentMessageRecord } from '../../../storage/repositories/pending-agent-message-repository.ts';

const LATE_DEAD_LETTER_ERROR = 'space-agent delivery dead-lettered';

export type SpaceAgentPendingDrainOutcome =
  | { action: 'skip' }
  | { action: 'drain'; rows: PendingAgentMessageRecord[] };

export interface SpaceAgentPendingDrainDeps {
  repo: {
    listPendingForTarget(workflowRunId: string, targetName: string): PendingAgentMessageRecord[];
    listByRunAndStatus?(workflowRunId: string, status: string): PendingAgentMessageRecord[];
    getById(id: string): PendingAgentMessageRecord | null | undefined;
    markDelivered(id: string, sessionId: string): void;
    recordDeliveryAttempt(id: string, error: string | null): PendingAgentMessageRecord | null;
    recordDeliveryError(id: string, error: string | null): void;
    markAttemptFailed(id: string, error: string): PendingAgentMessageRecord | null;
    markFailed(id: string, error: string): unknown;
    deferExpiration(ids: string[], ttlMs?: number): void;
    enforceRetention(options: { runId?: string | null; excludeIds?: string[] }): unknown;
    expireStale(runId: string, excludeIds?: string[]): unknown;
  };
  resolveReplySession(row: PendingAgentMessageRecord): string | null;
  probeDeliveryStatus(sessionId: string, messageId: string): string | undefined;
  onSettled(row: PendingAgentMessageRecord, deliveredSessionId: string): void;
  watchActiveDelivery?(row: PendingAgentMessageRecord): void;
  onFailed?(row: PendingAgentMessageRecord): void;
  deliverRow(row: PendingAgentMessageRecord): Promise<void>;
}

export interface SpaceAgentPendingDrainInput {
  workflowRunId: string;
  spaceChatSessionId: string;
  activeDeliveryIds?: string[];
  retentionExcludeIds?: string[];
}

interface SpaceAgentPendingDrainCtx extends SpaceAgentPendingDrainInput {
  retentionExcludeIds?: string[];
  deps: SpaceAgentPendingDrainDeps;
  listedRows?: PendingAgentMessageRecord[];
  activeDeliveryIds?: string[];
  excludedDeliveryIds?: string[];
  pendingRetryIds?: string[];
  pendingRows?: PendingAgentMessageRecord[];
}

function listRows(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  return {
    ...ctx,
    listedRows: ctx.deps.repo.listPendingForTarget(ctx.workflowRunId, 'space-agent'),
  };
}

function reconcileRows(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  const settledIds = new Set<string>();
  const activeDeliveryIds: string[] = [...(ctx.activeDeliveryIds ?? [])];
  const excludedDeliveryIds: string[] = [];
  const pendingRetryIds: string[] = [];
  for (const row of ctx.listedRows ?? []) {
    if (settledIds.has(row.id)) continue;
    const replyTo = ctx.deps.resolveReplySession(row);
    const candidates =
      replyTo && replyTo !== ctx.spaceChatSessionId
        ? [replyTo, ctx.spaceChatSessionId]
        : [ctx.spaceChatSessionId];
    let consumedAt: string | null = null;
    let activeSeen = false;
    let failedAt: string | null = null;
    for (const sessionId of candidates) {
      const sendStatus = ctx.deps.probeDeliveryStatus(sessionId, row.id);
      if (sendStatus === 'consumed') {
        consumedAt = sessionId;
        break;
      }
      if (sendStatus === 'enqueued' || sendStatus === 'submitted') activeSeen = true;
      if (sendStatus === 'failed') failedAt = sessionId;
    }
    if (consumedAt) {
      if (ctx.deps.repo.getById(row.id)?.status === 'pending') {
        ctx.deps.repo.markDelivered(row.id, consumedAt);
        ctx.deps.onSettled(row, consumedAt);
      }
      settledIds.add(row.id);
      continue;
    }
    if (activeSeen) {
      if (!activeDeliveryIds.includes(row.id)) activeDeliveryIds.push(row.id);
      ctx.deps.watchActiveDelivery?.(row);
      continue;
    }
    if (failedAt) {
      if (row.lastError === LATE_DEAD_LETTER_ERROR) {
        if (!pendingRetryIds.includes(row.id)) pendingRetryIds.push(row.id);
        continue;
      }
      if (row.attempts >= row.maxAttempts) {
        ctx.deps.repo.markFailed(row.id, LATE_DEAD_LETTER_ERROR);
        settledIds.add(row.id);
        continue;
      }
      if (row.attempts === 0) {
        const updated = ctx.deps.repo.markAttemptFailed(row.id, LATE_DEAD_LETTER_ERROR);
        if (updated?.status !== 'pending') {
          settledIds.add(row.id);
          continue;
        }
      } else {
        ctx.deps.repo.recordDeliveryError(row.id, LATE_DEAD_LETTER_ERROR);
      }
      if (!excludedDeliveryIds.includes(row.id)) excludedDeliveryIds.push(row.id);
      ctx.deps.onFailed?.(row);
      settledIds.add(row.id);
      continue;
    }
  }
  return { ...ctx, activeDeliveryIds, excludedDeliveryIds, pendingRetryIds };
}

function deferActiveDeliveries(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  const protectedDeliveryIds = [
    ...(ctx.activeDeliveryIds ?? []),
    ...(ctx.excludedDeliveryIds ?? []),
    ...(ctx.pendingRetryIds ?? []),
    ...(ctx.retentionExcludeIds ?? []),
  ];
  if (protectedDeliveryIds.length > 0) {
    ctx.deps.repo.deferExpiration(protectedDeliveryIds);
  }
  return ctx;
}

function runRetention(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  const excludeIds = [
    ...(ctx.activeDeliveryIds ?? []),
    ...(ctx.excludedDeliveryIds ?? []),
    ...(ctx.pendingRetryIds ?? []),
    ...(ctx.retentionExcludeIds ?? []),
  ];
  ctx.deps.repo.enforceRetention({ runId: ctx.workflowRunId, excludeIds });
  ctx.deps.repo.expireStale(ctx.workflowRunId, excludeIds);
  return ctx;
}

function listAdmissibleRows(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  const inadmissible = new Set([
    ...(ctx.activeDeliveryIds ?? []),
    ...(ctx.excludedDeliveryIds ?? []),
  ]);
  return {
    ...ctx,
    pendingRows: ctx.deps.repo
      .listPendingForTarget(ctx.workflowRunId, 'space-agent')
      .filter((row) => !inadmissible.has(row.id)),
  };
}

function admitDrain(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  const drain = decidePendingDrainAdmission({
    listings: [
      {
        targetName: 'space-agent',
        rows: ctx.pendingRows ?? [],
      },
    ],
    admission: { executionPresent: true, targetKind: 'space_agent' },
  });
  return { ...ctx, pendingRows: drain.action === 'skip' ? [] : drain.rows };
}

async function deliverAdmittedRows(
  ctx: SpaceAgentPendingDrainCtx
): Promise<SpaceAgentPendingDrainCtx> {
  for (const row of ctx.pendingRows ?? []) {
    await ctx.deps.deliverRow(row);
  }
  return ctx;
}

const run = (superpipe({})('space-agent-pending-drain') as PipelineAPI)
  .input(['ctx'])
  .pipe(listRows, 'ctx', 'ctx')
  .pipe(reconcileRows, 'ctx', 'ctx')
  .pipe(deferActiveDeliveries, 'ctx', 'ctx')
  .pipe(runRetention, 'ctx', 'ctx')
  .pipe(listAdmissibleRows, 'ctx', 'ctx')
  .pipe(admitDrain, 'ctx', 'ctx')
  .pipe(deliverAdmittedRows, 'ctx', 'ctx')
  .endAsync('ctx') as (input: SpaceAgentPendingDrainCtx) => Promise<SpaceAgentPendingDrainCtx>;

export async function runSpaceAgentPendingDrain(
  deps: SpaceAgentPendingDrainDeps,
  input: SpaceAgentPendingDrainInput
): Promise<SpaceAgentPendingDrainOutcome> {
  const ctx = await run({ ...input, deps });
  return { action: 'drain', rows: ctx.pendingRows ?? [] };
}

export function collectActiveSpaceDeliveryIds(args: {
  repo: SpaceAgentPendingDrainDeps['repo'];
  workflowRunId: string;
  spaceChatSessionId: string;
  resolveReplySession(row: PendingAgentMessageRecord): string | null;
  probeDeliveryStatus(sessionId: string, messageId: string): string | undefined;
}): string[] {
  const activeIds: string[] = [];
  for (const row of args.repo.listByRunAndStatus?.(args.workflowRunId, 'pending') ?? []) {
    if (row.targetKind !== 'space_agent') continue;
    const replyTo = args.resolveReplySession(row);
    const candidates =
      replyTo && replyTo !== args.spaceChatSessionId
        ? [replyTo, args.spaceChatSessionId]
        : [args.spaceChatSessionId];
    if (
      candidates.some((sessionId) => {
        const sendStatus = args.probeDeliveryStatus(sessionId, row.id);
        return (
          sendStatus === 'enqueued' ||
          sendStatus === 'submitted' ||
          sendStatus === 'consumed' ||
          sendStatus === 'failed'
        );
      })
    ) {
      activeIds.push(row.id);
    }
  }
  return activeIds;
}

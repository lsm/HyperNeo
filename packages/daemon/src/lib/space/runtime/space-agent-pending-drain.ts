import superpipe, { type PipelineAPI } from 'superpipe';
import { decidePendingDrainAdmission } from './pending-drain-decision-pipeline.ts';
import type { PendingAgentMessageRecord } from '../../../storage/repositories/pending-agent-message-repository.ts';

export type SpaceAgentPendingDrainOutcome =
  | { action: 'skip'; activeDeliveryIds: string[] }
  | { action: 'drain'; rows: PendingAgentMessageRecord[]; activeDeliveryIds: string[] };

export interface SpaceAgentPendingDrainDeps {
  repo: {
    listPendingForTarget(workflowRunId: string, targetName: string): PendingAgentMessageRecord[];
    listByRunAndStatus?(workflowRunId: string, status: string): PendingAgentMessageRecord[];
    getById(id: string): PendingAgentMessageRecord | null | undefined;
    markDelivered(id: string, sessionId: string): void;
    markAttemptFailed(id: string, error: string): PendingAgentMessageRecord | null;
    markFailed(id: string, error: string): unknown;
    deferExpiration(ids: string[], ttlMs?: number): void;
    enforceRetention(options: { runId?: string | null; excludeIds?: string[] }): unknown;
    expireStale(runId: string, excludeIds?: string[]): unknown;
  };
  resolveReplySession(row: PendingAgentMessageRecord): string | null;
  probeDeliveryStatus(sessionId: string, messageId: string): string | undefined;
  onSettled(row: PendingAgentMessageRecord, deliveredSessionId: string): void;
  deliverRow(row: PendingAgentMessageRecord): Promise<void>;
}

export interface SpaceAgentPendingDrainInput {
  workflowRunId: string;
  spaceChatSessionId: string;
}

interface SpaceAgentPendingDrainCtx extends SpaceAgentPendingDrainInput {
  deps: SpaceAgentPendingDrainDeps;
  listedRows?: PendingAgentMessageRecord[];
  activeDeliveryIds?: string[];
  pendingRows?: PendingAgentMessageRecord[];
}

function listRows(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  return {
    ...ctx,
    listedRows: ctx.deps.repo.listPendingForTarget(ctx.workflowRunId, 'space-agent'),
  };
}

function replyCandidates(ctx: SpaceAgentPendingDrainCtx, row: PendingAgentMessageRecord): string[] {
  const replyTo = ctx.deps.resolveReplySession(row);
  return replyTo && replyTo !== ctx.spaceChatSessionId
    ? [replyTo, ctx.spaceChatSessionId]
    : [ctx.spaceChatSessionId];
}

function settleConsumedRows(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  const activeDeliveryIds: string[] = [];
  for (const row of ctx.listedRows ?? []) {
    let consumedAt: string | null = null;
    let ownedByLegacyDelivery = false;
    for (const sessionId of replyCandidates(ctx, row)) {
      const sendStatus = ctx.deps.probeDeliveryStatus(sessionId, row.id);
      if (sendStatus === 'consumed') {
        consumedAt = sessionId;
        break;
      }
      if (sendStatus === 'enqueued' || sendStatus === 'submitted') {
        ownedByLegacyDelivery = true;
      }
    }
    if (consumedAt) {
      if (ctx.deps.repo.getById(row.id)?.status === 'pending') {
        ctx.deps.repo.markDelivered(row.id, consumedAt);
        ctx.deps.onSettled(row, consumedAt);
      }
      continue;
    }
    if (ownedByLegacyDelivery && !activeDeliveryIds.includes(row.id)) {
      activeDeliveryIds.push(row.id);
    }
  }
  return { ...ctx, activeDeliveryIds };
}

function runRetention(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  const excludeIds = [...(ctx.activeDeliveryIds ?? [])];
  if (excludeIds.length > 0) {
    ctx.deps.repo.deferExpiration(excludeIds);
  }
  ctx.deps.repo.enforceRetention({ runId: ctx.workflowRunId, excludeIds });
  ctx.deps.repo.expireStale(ctx.workflowRunId, excludeIds);
  return ctx;
}

function listAdmissibleRows(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  const inadmissible = new Set(ctx.activeDeliveryIds ?? []);
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
  .pipe(settleConsumedRows, 'ctx', 'ctx')
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
  return {
    action: 'drain',
    rows: ctx.pendingRows ?? [],
    activeDeliveryIds: ctx.activeDeliveryIds ?? [],
  };
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

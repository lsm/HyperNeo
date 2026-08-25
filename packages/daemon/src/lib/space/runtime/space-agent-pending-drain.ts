import superpipe, { type PipelineAPI } from 'superpipe';
import type { PendingAgentMessageRecord } from '../../../storage/repositories/pending-agent-message-repository.ts';
import { decidePendingDrainAdmission } from './pending-drain-decision-pipeline.ts';

export type SpaceAgentPendingDrainOutcome =
  | { action: 'skip' }
  | { action: 'drain'; rows: PendingAgentMessageRecord[] };

export interface SpaceAgentPendingDrainDeps {
  repo: {
    listPendingForTarget(workflowRunId: string, targetName: string): PendingAgentMessageRecord[];
    getById(id: string): { status: string } | null | undefined;
    markDelivered(id: string, sessionId: string): void;
    deferExpiration(ids: string[], ttlMs?: number): void;
    enforceRetention(options: { runId?: string | null; excludeIds?: string[] }): unknown;
    expireStale(runId: string): unknown;
  };
  resolveReplySession(row: PendingAgentMessageRecord): string | null;
  probeDeliveryStatus(sessionId: string, messageId: string): string | undefined;
  onSettled(row: PendingAgentMessageRecord, deliveredSessionId: string): void;
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
  outcome?: SpaceAgentPendingDrainOutcome;
}

function listRows(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  return {
    ...ctx,
    listedRows: ctx.deps.repo.listPendingForTarget(ctx.workflowRunId, 'space-agent'),
  };
}

function reconcileRows(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  const settledIds = new Set<string>();
  const activeDeliveryIds: string[] = [];
  for (const row of ctx.listedRows ?? []) {
    if (settledIds.has(row.id)) continue;
    const replyTo = ctx.deps.resolveReplySession(row);
    const candidates =
      replyTo && replyTo !== ctx.spaceChatSessionId
        ? [replyTo, ctx.spaceChatSessionId]
        : [ctx.spaceChatSessionId];
    let resolved = false;
    for (const sessionId of candidates) {
      const sendStatus = ctx.deps.probeDeliveryStatus(sessionId, row.id);
      if (sendStatus === 'consumed') {
        if (ctx.deps.repo.getById(row.id)?.status === 'pending') {
          ctx.deps.repo.markDelivered(row.id, sessionId);
          ctx.deps.onSettled(row, sessionId);
        }
        resolved = true;
        break;
      }
      if (sendStatus === 'enqueued' && !activeDeliveryIds.includes(row.id)) {
        activeDeliveryIds.push(row.id);
      }
    }
    if (resolved) settledIds.add(row.id);
  }
  return { ...ctx, activeDeliveryIds };
}

function deferActiveDeliveries(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  if ((ctx.activeDeliveryIds ?? []).length > 0) {
    ctx.deps.repo.deferExpiration(ctx.activeDeliveryIds!);
  }
  return ctx;
}

function runRetention(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  ctx.deps.repo.enforceRetention({
    runId: ctx.workflowRunId,
    excludeIds: ctx.activeDeliveryIds ?? [],
  });
  ctx.deps.repo.expireStale(ctx.workflowRunId);
  return ctx;
}

function listAdmissibleRows(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  return {
    ...ctx,
    pendingRows: ctx.deps.repo.listPendingForTarget(ctx.workflowRunId, 'space-agent'),
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
  if (drain.action === 'skip') {
    return { ...ctx, outcome: { action: 'skip' } };
  }
  return { ...ctx, outcome: { action: 'drain', rows: drain.rows } };
}

function hasOutcome(ctx: SpaceAgentPendingDrainCtx): boolean {
  return ctx.outcome !== undefined;
}

const run = (
  superpipe<{ hasOutcome: (ctx: SpaceAgentPendingDrainCtx) => boolean }>({
    hasOutcome,
  })('space-agent-pending-drain') as PipelineAPI
)
  .input(['ctx'])
  .pipe(listRows, 'ctx', 'ctx')
  .pipe(reconcileRows, 'ctx', 'ctx')
  .pipe(deferActiveDeliveries, 'ctx', 'ctx')
  .pipe(runRetention, 'ctx', 'ctx')
  .pipe(listAdmissibleRows, 'ctx', 'ctx')
  .pipe(admitDrain, 'ctx', 'ctx')
  .endAsync('ctx') as (input: SpaceAgentPendingDrainCtx) => Promise<SpaceAgentPendingDrainCtx>;

export async function runSpaceAgentPendingDrain(
  deps: SpaceAgentPendingDrainDeps,
  input: SpaceAgentPendingDrainInput
): Promise<SpaceAgentPendingDrainOutcome> {
  const ctx = await run({ ...input, deps });
  return ctx.outcome ?? { action: 'skip' };
}

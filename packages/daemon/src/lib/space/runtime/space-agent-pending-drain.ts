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
    enforceRetention(options: { runId?: string | null }): unknown;
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
  unsettledRows?: PendingAgentMessageRecord[];
  pendingRows?: PendingAgentMessageRecord[];
  outcome?: SpaceAgentPendingDrainOutcome;
}

function listRows(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  return {
    ...ctx,
    listedRows: ctx.deps.repo.listPendingForTarget(ctx.workflowRunId, 'space-agent'),
  };
}

function reconcileConsumed(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  const settledIds = new Set<string>();
  for (const row of ctx.listedRows ?? []) {
    const replyTo = ctx.deps.resolveReplySession(row);
    const candidates =
      replyTo && replyTo !== ctx.spaceChatSessionId
        ? [replyTo, ctx.spaceChatSessionId]
        : [ctx.spaceChatSessionId];
    for (const sessionId of candidates) {
      if (ctx.deps.probeDeliveryStatus(sessionId, row.id) !== 'consumed') continue;
      if (ctx.deps.repo.getById(row.id)?.status === 'pending') {
        ctx.deps.repo.markDelivered(row.id, sessionId);
        ctx.deps.onSettled(row, sessionId);
      }
      settledIds.add(row.id);
      break;
    }
  }
  return {
    ...ctx,
    unsettledRows: (ctx.listedRows ?? []).filter((row) => !settledIds.has(row.id)),
  };
}

function runRetention(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  ctx.deps.repo.enforceRetention({ runId: ctx.workflowRunId });
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
  .pipe(reconcileConsumed, 'ctx', 'ctx')
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

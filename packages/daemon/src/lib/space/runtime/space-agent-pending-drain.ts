import superpipe, { type PipelineAPI } from 'superpipe';
import type { PendingAgentMessageRecord } from '../../../storage/repositories/pending-agent-message-repository.ts';
import { decidePendingDrainAdmission } from './pending-drain-decision-pipeline.ts';

const LATE_DEAD_LETTER_ERROR = 'late delivery dead-lettered';

export type SpaceAgentPendingDrainOutcome =
  | { action: 'skip' }
  | { action: 'drain'; rows: PendingAgentMessageRecord[] };

export interface SpaceAgentPendingDrainDeps {
  repo: {
    listPendingForTarget(workflowRunId: string, targetName: string): PendingAgentMessageRecord[];
    listByRunAndStatus?(workflowRunId: string, status: string): PendingAgentMessageRecord[];
    getById(id: string): { status: string } | null | undefined;
    markDelivered(id: string, sessionId: string): void;
    markAttemptFailed(id: string, error: string): unknown;
    markLateDeadLetter(id: string, sentinel: string): unknown;
    clearLateDeadLetter(id: string): void;
    deferExpiration(ids: string[], ttlMs?: number): void;
    enforceRetention(options: { runId?: string | null; excludeIds?: string[] }): unknown;
    expireStale(runId: string, excludeIds?: string[]): unknown;
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
    let consumedAt: string | null = null;
    let activeSeen = false;
    let failedSeen = false;
    for (const sessionId of candidates) {
      const sendStatus = ctx.deps.probeDeliveryStatus(sessionId, row.id);
      if (sendStatus === 'consumed') {
        consumedAt = sessionId;
        break;
      }
      if (sendStatus === 'enqueued' || sendStatus === 'submitted') activeSeen = true;
      if (sendStatus === 'failed') failedSeen = true;
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
      continue;
    }
    if (failedSeen) {
      ctx.deps.repo.markLateDeadLetter(row.id, LATE_DEAD_LETTER_ERROR);
      ctx.deps.repo.deferExpiration([row.id]);
      settledIds.add(row.id);
      continue;
    }
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
  ctx.deps.repo.expireStale(ctx.workflowRunId, ctx.activeDeliveryIds ?? []);
  return ctx;
}

function listAdmissibleRows(ctx: SpaceAgentPendingDrainCtx): SpaceAgentPendingDrainCtx {
  const active = new Set(ctx.activeDeliveryIds ?? []);
  return {
    ...ctx,
    pendingRows: ctx.deps.repo
      .listPendingForTarget(ctx.workflowRunId, 'space-agent')
      .filter((row) => !active.has(row.id)),
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
        return sendStatus === 'enqueued' || sendStatus === 'submitted' || sendStatus === 'consumed';
      })
    ) {
      activeIds.push(row.id);
    }
  }
  return activeIds;
}

export async function runSpaceAgentPendingDrain(
  deps: SpaceAgentPendingDrainDeps,
  input: SpaceAgentPendingDrainInput
): Promise<SpaceAgentPendingDrainOutcome> {
  const ctx = await run({ ...input, deps });
  return ctx.outcome ?? { action: 'skip' };
}

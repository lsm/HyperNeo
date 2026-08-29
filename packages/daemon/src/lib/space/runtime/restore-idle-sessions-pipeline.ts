import superpipe, { type PipelineAPI } from 'superpipe';
import type {
  ExternalEventDeliveryRecord,
  ExternalEventRecord,
} from '../../external-events/types.ts';

export interface RestoreIdleSessionTarget {
  workflowRunId: string;
  taskId: string;
  nodeId: string;
  agentName: string;
}

export interface RestoreIdleSessionExecution {
  executionId: string;
  agentSessionId: string;
}

export interface RestoreIdleSessionsDeps {
  listPendingDeliveries: (workflowRunId?: string) => ExternalEventDeliveryRecord[];
  getEventRecord: (eventId: string) => ExternalEventRecord | null | undefined;
  isDeliveryInFlight: (deliveryKey: string) => boolean;
  isDeliveryExpired: (createdAt: number, now: number) => boolean;
  getRunSpaceId: (workflowRunId: string) => string | undefined;
  isSpacePaused: (spaceId: string) => boolean;
  getSpaceState: (spaceId: string) => Promise<{ paused: boolean; stopped: boolean } | null>;
  isTargetStillSubscribed: (target: RestoreIdleSessionTarget, topic: string) => boolean;
  isTaskAdmissible: (taskId: string) => boolean;
  findIdleExecutionWithDeadSession: (
    target: RestoreIdleSessionTarget
  ) => RestoreIdleSessionExecution | undefined;
  restoreSession: (target: RestoreIdleSessionTarget) => Promise<void>;
  isExecutionRestorable: (execution: RestoreIdleSessionExecution) => boolean;
  cancelSession: (sessionId: string) => void;
}

export type RestoreIdleSessionsOutcome =
  | { action: 'restored'; sessionId: string }
  | { action: 'skipped_inactivation'; sessionId: string }
  | { action: 'failed' };

export interface RestoreIdleSessionsCtx {
  workflowRunId?: string;
  deps: RestoreIdleSessionsDeps;
  candidates?: Array<{
    target: RestoreIdleSessionTarget;
    execution: RestoreIdleSessionExecution;
  }>;
  outcomes: RestoreIdleSessionsOutcome[];
}

export async function collectAdmissibleCandidates(
  ctx: RestoreIdleSessionsCtx
): Promise<RestoreIdleSessionsCtx> {
  const candidates: Array<{
    target: RestoreIdleSessionTarget;
    execution: RestoreIdleSessionExecution;
  }> = [];
  const admittedTargets = new Set<string>();
  const spaceStateById = new Map<string, { paused: boolean; stopped: boolean } | null>();
  const resolveSpaceState = async (
    spaceId: string
  ): Promise<{ paused: boolean; stopped: boolean } | null> => {
    if (!spaceStateById.has(spaceId)) {
      spaceStateById.set(spaceId, await ctx.deps.getSpaceState(spaceId).catch(() => null));
    }
    return spaceStateById.get(spaceId) ?? null;
  };
  for (const delivery of ctx.deps.listPendingDeliveries(ctx.workflowRunId)) {
    const spaceId = ctx.deps.getRunSpaceId(delivery.workflowRunId);
    if (!spaceId || ctx.deps.isSpacePaused(spaceId)) continue;
    if (ctx.deps.isDeliveryInFlight(delivery.deliveryKey)) continue;
    const eventRecord = ctx.deps.getEventRecord(delivery.eventId);
    if (!eventRecord || eventRecord.state !== 'published') continue;
    if (ctx.deps.isDeliveryExpired(eventRecord.createdAt, Date.now())) continue;
    const spaceState = await resolveSpaceState(spaceId);
    if (!spaceState || spaceState.paused || spaceState.stopped) continue;
    const target: RestoreIdleSessionTarget = {
      workflowRunId: delivery.workflowRunId,
      taskId: delivery.taskId,
      nodeId: delivery.nodeId,
      agentName: delivery.agentName,
    };
    if (!ctx.deps.isTargetStillSubscribed(target, eventRecord.event.topic)) continue;
    if (!ctx.deps.isTaskAdmissible(delivery.taskId)) continue;
    const execution = ctx.deps.findIdleExecutionWithDeadSession(target);
    if (!execution) continue;
    const targetKey = `${target.workflowRunId}:${target.nodeId}:${target.agentName}`;
    if (admittedTargets.has(targetKey)) continue;
    admittedTargets.add(targetKey);
    candidates.push({ target, execution });
  }
  return { ...ctx, candidates };
}

export async function restoreWithRevalidation(
  ctx: RestoreIdleSessionsCtx
): Promise<RestoreIdleSessionsCtx> {
  const outcomes: RestoreIdleSessionsOutcome[] = [];
  for (const { target, execution } of ctx.candidates ?? []) {
    try {
      await ctx.deps.restoreSession(target);
    } catch {
      outcomes.push({ action: 'failed' });
      continue;
    }
    const spaceId = ctx.deps.getRunSpaceId(target.workflowRunId);
    const spaceState = spaceId ? await ctx.deps.getSpaceState(spaceId).catch(() => null) : null;
    const taskAdmissible = ctx.deps.isTaskAdmissible(target.taskId);
    const executionRestorable = ctx.deps.isExecutionRestorable(execution);
    if (
      !spaceState ||
      spaceState.paused ||
      spaceState.stopped ||
      !taskAdmissible ||
      !executionRestorable
    ) {
      ctx.deps.cancelSession(execution.agentSessionId);
      outcomes.push({ action: 'skipped_inactivation', sessionId: execution.agentSessionId });
      continue;
    }
    outcomes.push({ action: 'restored', sessionId: execution.agentSessionId });
  }
  return { ...ctx, outcomes };
}

function hasCandidates(ctx: RestoreIdleSessionsCtx): boolean {
  return (ctx.candidates?.length ?? 0) > 0;
}

const run = (
  superpipe<{ hasCandidates: (ctx: RestoreIdleSessionsCtx) => boolean }>({
    hasCandidates,
  })('restore-idle-sessions') as PipelineAPI
)
  .input(['ctx'])
  .pipe(collectAdmissibleCandidates, 'ctx', 'ctx')
  .pipe('hasCandidates', 'ctx')
  .pipe(restoreWithRevalidation, 'ctx', 'ctx')
  .endAsync('ctx') as (input: RestoreIdleSessionsCtx) => Promise<RestoreIdleSessionsCtx>;

export async function runRestoreIdleSessions(
  deps: RestoreIdleSessionsDeps,
  workflowRunId?: string
): Promise<RestoreIdleSessionsOutcome[]> {
  const ctx = await run({ workflowRunId, deps, outcomes: [] });
  return ctx.outcomes;
}

import superpipe, { type PipelineAPI } from 'superpipe';
import type {
  ExternalEventDeliveryRecord,
  ExternalEventRecord,
} from '../../external-events/types.ts';

export interface RequeueWorkflowDeliveryTarget {
  workflowRunId: string;
  taskId: string;
  nodeId: string;
  agentName: string;
}

export interface RequeuePendingDeliveryDeps {
  isDeliveryInFlight: (deliveryKey: string) => boolean;
  isDeliveryExpired: (createdAt: number, now: number) => boolean;
  failDeliveryTerminal: (delivery: ExternalEventDeliveryRecord, reason: string) => void;
  isTargetSpacePaused: (workflowRunId: string) => boolean;
  isTargetStillSubscribed: (target: RequeueWorkflowDeliveryTarget, topic: string) => boolean;
  resolveTargetSession: (target: RequeueWorkflowDeliveryTarget) => string | undefined;
  isSessionLive: (sessionId: string) => boolean;
  isSessionInterrupted: (sessionId: string) => boolean;
  scheduleDigestPull: (sessionId: string, taskId: string) => void;
  scheduleInterruptProbe: (sessionId: string, taskId: string) => void;
}

export type RequeuePendingDeliveryOutcome =
  | { action: 'skip'; reason: 'delivery_in_flight' }
  | { action: 'fail'; reason: 'ttl_expired' | 'subscription_no_longer_active' }
  | { action: 'skip'; reason: 'space_paused_or_missing' }
  | { action: 'skip'; reason: 'session_unavailable' }
  | { action: 'probe'; sessionId: string }
  | { action: 'schedule'; sessionId: string };

export interface RequeuePendingDeliveryCtx {
  delivery: ExternalEventDeliveryRecord;
  eventRecord: ExternalEventRecord;
  deps: RequeuePendingDeliveryDeps;
  target?: RequeueWorkflowDeliveryTarget;
  sessionId?: string;
  outcome?: RequeuePendingDeliveryOutcome;
}

export function claimDelivery(ctx: RequeuePendingDeliveryCtx): RequeuePendingDeliveryCtx {
  if (ctx.deps.isDeliveryInFlight(ctx.delivery.deliveryKey)) {
    return { ...ctx, outcome: { action: 'skip', reason: 'delivery_in_flight' } };
  }
  return ctx;
}

export function expirePastTtl(ctx: RequeuePendingDeliveryCtx): RequeuePendingDeliveryCtx {
  if (ctx.deps.isDeliveryExpired(ctx.eventRecord.createdAt, Date.now())) {
    ctx.deps.failDeliveryTerminal(ctx.delivery, 'ttl_expired');
    return { ...ctx, outcome: { action: 'fail', reason: 'ttl_expired' } };
  }
  return ctx;
}

export function admitTargetSpace(ctx: RequeuePendingDeliveryCtx): RequeuePendingDeliveryCtx {
  if (ctx.deps.isTargetSpacePaused(ctx.delivery.workflowRunId)) {
    return { ...ctx, outcome: { action: 'skip', reason: 'space_paused_or_missing' } };
  }
  return {
    ...ctx,
    target: {
      workflowRunId: ctx.delivery.workflowRunId,
      taskId: ctx.delivery.taskId,
      nodeId: ctx.delivery.nodeId,
      agentName: ctx.delivery.agentName,
    },
  };
}

export function admitSubscription(ctx: RequeuePendingDeliveryCtx): RequeuePendingDeliveryCtx {
  if (!ctx.deps.isTargetStillSubscribed(ctx.target!, ctx.eventRecord.event.topic)) {
    ctx.deps.failDeliveryTerminal(ctx.delivery, 'subscription_no_longer_active');
    return { ...ctx, outcome: { action: 'fail', reason: 'subscription_no_longer_active' } };
  }
  return ctx;
}

export function resolveSession(ctx: RequeuePendingDeliveryCtx): RequeuePendingDeliveryCtx {
  const sessionId = ctx.deps.resolveTargetSession(ctx.target!);
  if (!sessionId || !ctx.deps.isSessionLive(sessionId)) {
    return { ...ctx, outcome: { action: 'skip', reason: 'session_unavailable' } };
  }
  return { ...ctx, sessionId };
}

export function armDigestPull(ctx: RequeuePendingDeliveryCtx): RequeuePendingDeliveryCtx {
  const sessionId = ctx.sessionId!;
  const taskId = ctx.delivery.taskId;
  if (ctx.deps.isSessionInterrupted(sessionId)) {
    ctx.deps.scheduleInterruptProbe(sessionId, taskId);
    return { ...ctx, outcome: { action: 'probe', sessionId } };
  }
  ctx.deps.scheduleDigestPull(sessionId, taskId);
  return { ...ctx, outcome: { action: 'schedule', sessionId } };
}

function hasOutcome(ctx: RequeuePendingDeliveryCtx): boolean {
  return ctx.outcome !== undefined;
}

const run = (
  superpipe<{ hasOutcome: (ctx: RequeuePendingDeliveryCtx) => boolean }>({
    hasOutcome,
  })('requeue-pending-delivery') as PipelineAPI
)
  .input(['ctx'])
  .pipe(claimDelivery, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(expirePastTtl, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(admitTargetSpace, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(admitSubscription, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(resolveSession, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(armDigestPull, 'ctx', 'ctx')
  .end('ctx') as (input: RequeuePendingDeliveryCtx) => RequeuePendingDeliveryCtx;

export function runRequeuePendingDelivery(
  deps: RequeuePendingDeliveryDeps,
  input: { delivery: ExternalEventDeliveryRecord; eventRecord: ExternalEventRecord }
): RequeuePendingDeliveryOutcome {
  const ctx = run({ ...input, deps });
  return ctx.outcome ?? { action: 'skip', reason: 'session_unavailable' };
}

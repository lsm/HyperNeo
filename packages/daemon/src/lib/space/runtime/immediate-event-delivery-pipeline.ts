import { createHash } from 'node:crypto';
import type { NodeExecution, SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import type { SDKMessageRepository } from '../../../storage/repositories/sdk-message-repository.ts';
import { deliverMessage, type MessageDeliveryRole } from '../../agent/message-delivery.ts';
import { buildSyntheticExternalEventMessage } from '../../external-events/deferred-event-digest.ts';
import type { ExternalEventPublishedPayload } from '../../external-events/external-event-service.ts';
import type { ExternalEventStore } from '../../external-events/external-event-store.ts';
import {
  prepareExternalEventTask,
  resolveSubscriptionTarget,
  type WorkflowTargetKey,
} from './external-event-admission-gates.ts';
import {
  applyClaimConflictGate,
  applySubscriptionGate,
  applyTaskAdmissionGate,
  applyTerminalGate,
  type ExternalEventDeliveryCtx,
} from './external-event-delivery-pipeline.ts';

export type ImmediateEventMechanics = 'steer' | 'turn';

export type ImmediateEventDeliveryOutcome =
  | { action: 'skip'; reason: 'delivery_terminal' | 'claim_conflict' }
  | { action: 'failed'; reason: string }
  | { action: 'deferred'; reason: string }
  | {
      action: 'delivered';
      mechanics: ImmediateEventMechanics;
      deliveryRole: MessageDeliveryRole;
      messageUuid: string;
    }
  | { action: 'error'; stage: 'persistAndEnqueue' | 'markLedger'; error: unknown };

export interface ImmediateEventDeliveryDeps {
  getTask(taskId: string): SpaceTask | null;
  getRun(workflowRunId: string): SpaceWorkflowRun | null;
  listExecutions(workflowRunId: string): readonly NodeExecution[];
  isDeliveryInFlight(deliveryKey: string): boolean;
  isSubscriptionActive(target: WorkflowTargetKey, topic: string): boolean;
  getSessionStatus(sessionId: string): string;
  withinRateBudget(sessionId: string): boolean;
  messages: Pick<SDKMessageRepository, 'getUserMessageByUuid' | 'saveUserMessage'>;
  jobQueue: Pick<JobQueueRepository, 'getActiveDeliveryRole' | 'enqueue'>;
  eventStore: Pick<
    ExternalEventStore,
    | 'isDeliveryTerminal'
    | 'markDeliveryDelivered'
    | 'markDeliveryFailed'
    | 'markEventDeliveredIfAllDeliveriesDelivered'
  >;
}

export interface ImmediateEventDeliveryInput {
  event: ExternalEventPublishedPayload;
  render: string | null;
  target: WorkflowTargetKey;
  deliveryKey: string;
}

interface ImmediateEventDeliveryCtx extends ImmediateEventDeliveryInput {
  deps: ImmediateEventDeliveryDeps;
  sessionId?: string;
  mechanics?: ImmediateEventMechanics;
  messageUuid?: string;
  message?: SDKUserMessage;
  deliveryRole?: MessageDeliveryRole;
  outcome?: ImmediateEventDeliveryOutcome;
}

function settled(
  ctx: ImmediateEventDeliveryCtx,
  outcome: ImmediateEventDeliveryOutcome
): ImmediateEventDeliveryCtx {
  return { ...ctx, outcome };
}

export const IMMEDIATE_EVENT_MESSAGE_UUID_PREFIX = 'ev-';

export function buildImmediateEventMessageUuid(eventId: string, deliveryKey: string): string {
  const digest = createHash('sha256').update(`${eventId}\u0000${deliveryKey}`).digest('hex');
  return (
    `${IMMEDIATE_EVENT_MESSAGE_UUID_PREFIX}${digest.slice(0, 8)}-${digest.slice(8, 12)}` +
    `-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
  );
}

export function resolveTarget(ctx: ImmediateEventDeliveryCtx): ImmediateEventDeliveryCtx {
  const resolved = resolveSubscriptionTarget(
    ctx.deps.listExecutions(ctx.target.workflowRunId),
    ctx.target
  );
  return { ...ctx, sessionId: resolved.sessionId };
}

export function routingGates(ctx: ImmediateEventDeliveryCtx): ImmediateEventDeliveryCtx {
  const deliveryCtx: ExternalEventDeliveryCtx = {
    deliveryTerminal: ctx.deps.eventStore.isDeliveryTerminal(ctx.event.eventId, ctx.deliveryKey),
    deliveryInFlight: ctx.deps.isDeliveryInFlight(ctx.deliveryKey),
    subscriptionActive: ctx.deps.isSubscriptionActive(ctx.target, ctx.event.topic),
    taskDecision: prepareExternalEventTask(
      ctx.deps.getTask(ctx.target.taskId),
      ctx.deps.getRun(ctx.target.workflowRunId),
      ctx.event
    ),
    targetHasSession: false,
    targetSessionLive: false,
    targetSpacePaused: false,
    executionPendingActivation: false,
    decision: null,
  };
  const gated = applyTaskAdmissionGate(
    applySubscriptionGate(applyClaimConflictGate(applyTerminalGate(deliveryCtx)))
  );
  const decision = gated.decision;
  if (decision === null) return ctx;
  if (decision.action === 'skip') {
    return settled(ctx, { action: 'skip', reason: 'delivery_terminal' });
  }
  if (decision.action === 'skipClaimConflict') {
    return settled(ctx, { action: 'skip', reason: 'claim_conflict' });
  }
  if (decision.action === 'failDelivery') {
    ctx.deps.eventStore.markDeliveryFailed(ctx.event.eventId, ctx.deliveryKey, {
      terminal: true,
      reason: decision.reason,
    });
    return settled(ctx, { action: 'failed', reason: decision.reason });
  }
  return settled(ctx, { action: 'deferred', reason: 'task_stopped' });
}

export function pickMechanics(ctx: ImmediateEventDeliveryCtx): ImmediateEventDeliveryCtx {
  if (!ctx.sessionId) return settled(ctx, { action: 'deferred', reason: 'no_active_session' });
  if (!ctx.deps.withinRateBudget(ctx.sessionId)) {
    return settled(ctx, { action: 'deferred', reason: 'rate_budget' });
  }
  return {
    ...ctx,
    mechanics: ctx.deps.getSessionStatus(ctx.sessionId) === 'processing' ? 'steer' : 'turn',
  };
}

export function buildHandoff(ctx: ImmediateEventDeliveryCtx): ImmediateEventDeliveryCtx {
  if (ctx.render === null) return settled(ctx, { action: 'deferred', reason: 'render_missing' });
  const messageUuid = buildImmediateEventMessageUuid(ctx.event.eventId, ctx.deliveryKey);
  return {
    ...ctx,
    messageUuid,
    message: buildSyntheticExternalEventMessage(ctx.sessionId!, ctx.render, messageUuid),
  };
}

export function persistAndEnqueue(ctx: ImmediateEventDeliveryCtx): ImmediateEventDeliveryCtx {
  try {
    if (!ctx.deps.messages.getUserMessageByUuid(ctx.sessionId!, ctx.messageUuid!)) {
      ctx.deps.messages.saveUserMessage(ctx.sessionId!, ctx.message!, 'enqueued');
    }
    const deliveryRole = deliverMessage(
      ctx.deps.jobQueue as JobQueueRepository,
      ctx.sessionId!,
      ctx.messageUuid!,
      {
        origin: 'space_inject',
        ...(ctx.mechanics === 'steer' ? { role: 'steer' as const } : {}),
      }
    );
    return { ...ctx, deliveryRole };
  } catch (error) {
    return settled(ctx, { action: 'error', stage: 'persistAndEnqueue', error });
  }
}

export function markLedger(ctx: ImmediateEventDeliveryCtx): ImmediateEventDeliveryCtx {
  try {
    ctx.deps.eventStore.markDeliveryDelivered(ctx.event.eventId, ctx.deliveryKey);
    ctx.deps.eventStore.markEventDeliveredIfAllDeliveriesDelivered(ctx.event.eventId);
  } catch (error) {
    return settled(ctx, { action: 'error', stage: 'markLedger', error });
  }
  return settled(ctx, {
    action: 'delivered',
    mechanics: ctx.mechanics!,
    deliveryRole: ctx.deliveryRole!,
    messageUuid: ctx.messageUuid!,
  });
}

const run = (
  superpipe<{ hasOutcome: (ctx: ImmediateEventDeliveryCtx) => boolean }>({
    hasOutcome: (ctx: ImmediateEventDeliveryCtx): boolean => ctx.outcome !== undefined,
  })('deliver-immediate-event') as PipelineAPI
)
  .input(['ctx'])
  .pipe(resolveTarget, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(routingGates, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(pickMechanics, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(buildHandoff, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(persistAndEnqueue, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(markLedger, 'ctx', 'ctx')
  .end('ctx') as (input: ImmediateEventDeliveryCtx) => ImmediateEventDeliveryCtx;

export function deliverImmediateEvent(
  deps: ImmediateEventDeliveryDeps,
  input: ImmediateEventDeliveryInput
): ImmediateEventDeliveryOutcome {
  const ctx = run({ ...input, deps });
  return (
    ctx.outcome ?? { action: 'error', stage: 'markLedger', error: new Error('missing outcome') }
  );
}

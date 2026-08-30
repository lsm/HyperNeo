import { createHash } from 'node:crypto';
import type { NodeExecution, SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import type { SDKMessageRepository } from '../../../storage/repositories/sdk-message-repository.ts';
import { ensurePrompt, retryPrompt } from '../../agent/message-delivery-outbox.ts';
import type { MessageDeliveryRole } from '../../agent/message-delivery.ts';
import { buildSyntheticExternalEventMessage } from '../../external-events/deferred-event-digest.ts';
import type { ExternalEventPublishedPayload } from '../../external-events/external-event-service.ts';
import type { ExternalEventStore } from '../../external-events/external-event-store.ts';
import {
  prepareExternalEventTask,
  resolveCurrentQueueableOrActiveExecution,
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
      deliveryRole: MessageDeliveryRole | null;
      messageUuid: string;
    }
  | { action: 'error'; stage: 'persistAndEnqueue' | 'markLedger'; error: unknown };

export interface ImmediateEventDeliveryDeps {
  getTask(taskId: string): SpaceTask | null;
  getRun(workflowRunId: string): SpaceWorkflowRun | null;
  listExecutions(workflowRunId: string): readonly NodeExecution[];
  isDeliveryInFlight(deliveryKey: string): boolean;
  isSubscriptionActive(target: WorkflowTargetKey, topic: string): boolean;
  isTargetSpacePaused(target: WorkflowTargetKey): boolean;
  isTargetSessionLive(sessionId: string): boolean;
  isSessionInterruptInProgress(sessionId: string): boolean;
  getSessionStatus(sessionId: string): string;
  withinRateBudget(sessionId: string): boolean;
  setQueuedIfIdle(sessionId: string, messageUuid: string): Promise<boolean>;
  db: BunDatabase;
  messages: SDKMessageRepository;
  jobQueue: JobQueueRepository;
  eventStore: Pick<
    ExternalEventStore,
    | 'isDeliveryTerminal'
    | 'markDeliveryMailboxAccepted'
    | 'markDeliveryFailed'
    | 'markEventDeliveredIfAllDeliveriesDelivered'
    | 'markEventFailedIfAllDeliveriesTerminal'
  >;
}

export interface ImmediateEventDeliveryInput {
  event: ExternalEventPublishedPayload;
  render: string | null;
  target: WorkflowTargetKey;
  deliveryKey: string;
}

interface ImmediateEventDeliveryCtx extends ImmediateEventDeliveryInput, ExternalEventDeliveryCtx {
  deps: ImmediateEventDeliveryDeps;
  sessionId?: string;
  mechanics?: ImmediateEventMechanics;
  messageUuid?: string;
  message?: SDKUserMessage;
  deliveryRole?: MessageDeliveryRole | null;
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
  const current = resolveCurrentQueueableOrActiveExecution(
    ctx.deps.listExecutions(ctx.target.workflowRunId),
    ctx.target
  );
  const sessionId = current?.agentSessionId ?? undefined;
  return {
    ...ctx,
    sessionId,
    deliveryTerminal: ctx.deps.eventStore.isDeliveryTerminal(ctx.event.eventId, ctx.deliveryKey),
    deliveryInFlight: ctx.deps.isDeliveryInFlight(ctx.deliveryKey),
    subscriptionActive: ctx.deps.isSubscriptionActive(ctx.target, ctx.event.topic),
    taskDecision: prepareExternalEventTask(
      ctx.deps.getTask(ctx.target.taskId),
      ctx.deps.getRun(ctx.target.workflowRunId),
      ctx.event
    ),
    targetHasSession: sessionId !== undefined,
    targetSessionLive: sessionId !== undefined && ctx.deps.isTargetSessionLive(sessionId),
    targetSpacePaused: ctx.deps.isTargetSpacePaused(ctx.target),
    executionPendingActivation:
      current?.status === 'pending' || current?.status === 'waiting_rebind',
    decision: null,
  };
}

function undecided<Ctx extends ExternalEventDeliveryCtx>(
  gate: (ctx: Ctx) => Ctx
): (ctx: Ctx) => Ctx {
  return (ctx) => (ctx.decision === null ? gate(ctx) : ctx);
}

export function settleRoutingDecision(ctx: ImmediateEventDeliveryCtx): ImmediateEventDeliveryCtx {
  const decision = ctx.decision;
  if (decision === null) {
    if (ctx.targetSpacePaused) {
      return settled(ctx, { action: 'deferred', reason: 'space_paused' });
    }
    return ctx;
  }
  if (decision.action === 'skip') {
    ctx.deps.eventStore.markEventDeliveredIfAllDeliveriesDelivered(ctx.event.eventId);
    ctx.deps.eventStore.markEventFailedIfAllDeliveriesTerminal(ctx.event.eventId);
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
    ctx.deps.eventStore.markEventFailedIfAllDeliveriesTerminal(ctx.event.eventId);
    return settled(ctx, { action: 'failed', reason: decision.reason });
  }
  return settled(ctx, { action: 'deferred', reason: 'task_stopped' });
}

export function pickMechanics(ctx: ImmediateEventDeliveryCtx): ImmediateEventDeliveryCtx {
  if (!ctx.sessionId) return settled(ctx, { action: 'deferred', reason: 'no_active_session' });
  if (!ctx.targetSessionLive) {
    return settled(ctx, { action: 'deferred', reason: 'stale_session' });
  }
  if (ctx.deps.isSessionInterruptInProgress(ctx.sessionId)) {
    return settled(ctx, { action: 'deferred', reason: 'session_interrupted' });
  }
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

export async function persistAndEnqueue(
  ctx: ImmediateEventDeliveryCtx
): Promise<ImmediateEventDeliveryCtx> {
  try {
    const ensured = ensurePrompt({
      db: ctx.deps.db,
      sdkMessageRepo: ctx.deps.messages,
      jobQueue: ctx.deps.jobQueue,
      sessionId: ctx.sessionId!,
      message: ctx.message!,
      origin: 'system',
      delivery: { origin: 'space_inject' },
    });
    let deliveryRole = ensured.role;
    if (deliveryRole === null && !ensured.created) {
      const retried = await retryPrompt({
        db: ctx.deps.db,
        jobQueue: ctx.deps.jobQueue,
        sdkMessageRepo: ctx.deps.messages,
        sessionId: ctx.sessionId!,
        messageUuid: ctx.messageUuid!,
        origin: 'space_inject',
      });
      deliveryRole = retried?.role ?? null;
    }
    if (deliveryRole === 'turn') {
      await ctx.deps.setQueuedIfIdle(ctx.sessionId!, ctx.messageUuid!).catch(() => {});
    }
    return { ...ctx, deliveryRole };
  } catch (error) {
    return settled(ctx, { action: 'error', stage: 'persistAndEnqueue', error });
  }
}

export function markLedger(ctx: ImmediateEventDeliveryCtx): ImmediateEventDeliveryCtx {
  try {
    ctx.deps.eventStore.markDeliveryMailboxAccepted(ctx.event.eventId, ctx.deliveryKey);
    ctx.deps.eventStore.markEventDeliveredIfAllDeliveriesDelivered(ctx.event.eventId);
    ctx.deps.eventStore.markEventFailedIfAllDeliveriesTerminal(ctx.event.eventId);
  } catch (error) {
    return settled(ctx, { action: 'error', stage: 'markLedger', error });
  }
  return settled(ctx, {
    action: 'delivered',
    mechanics: ctx.mechanics!,
    deliveryRole: ctx.deliveryRole ?? null,
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
  .pipe(undecided(applyTerminalGate), 'ctx', 'ctx')
  .pipe(undecided(applyClaimConflictGate), 'ctx', 'ctx')
  .pipe(undecided(applySubscriptionGate), 'ctx', 'ctx')
  .pipe(undecided(applyTaskAdmissionGate), 'ctx', 'ctx')
  .pipe(settleRoutingDecision, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(pickMechanics, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(buildHandoff, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(persistAndEnqueue, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(markLedger, 'ctx', 'ctx')
  .endAsync('ctx') as (
  input: ImmediateEventDeliveryInput & { deps: ImmediateEventDeliveryDeps }
) => Promise<ImmediateEventDeliveryCtx>;

export async function deliverImmediateEvent(
  deps: ImmediateEventDeliveryDeps,
  input: ImmediateEventDeliveryInput
): Promise<ImmediateEventDeliveryOutcome> {
  const ctx = await run({ ...input, deps });
  return (
    ctx.outcome ?? { action: 'error', stage: 'markLedger', error: new Error('missing outcome') }
  );
}

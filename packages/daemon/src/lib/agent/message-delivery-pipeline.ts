import type { SendStatus } from '../../storage/repositories/sdk-message-repository';
import { decisionRun } from '../space/runtime/decision-pipeline';
import type { InjectContextResetPlan, TurnEndFlushContextResetPlan } from './context-reset-planner';
import { planInjectContextReset, planTurnEndFlushContextReset } from './context-reset-planner';
import type { FlushDeliveryPlan, FlushMessage, FlushSkipEntry } from './message-ownership-gates';
import { decideDeferAdmission, planFlushDelivery } from './message-ownership-gates';

function decided<Ctx extends { decision: unknown }>(
  ctx: Ctx,
  decision: NonNullable<Ctx['decision']>
): Ctx {
  return { ...ctx, decision };
}

export type InjectDeliveryDecision =
  | { action: 'noop' }
  | { action: 'defer' }
  | InjectContextResetPlan
  | { action: 'deliver' };

export interface InjectDeliveryCtx {
  existingSendStatus: SendStatus | null;
  deliveryMode: 'immediate' | 'defer';
  isBusy: boolean;
  inRateLimitCooldown: boolean;
  parentTaskLimited: boolean;
  inputKind: string;
  hasPriorContext: boolean;
  slotResetsContext: boolean;
  hasActiveDeliveryJob: boolean;
  hasUnconsumedDeliveredWork: boolean;
  reopenFailedDelivery: boolean;
  decision: InjectDeliveryDecision | null;
}

export type InjectDeliveryInput = Omit<InjectDeliveryCtx, 'decision' | 'reopenFailedDelivery'>;

export interface InjectDeliveryOutcome {
  decision: InjectDeliveryDecision;
  reopenFailedDelivery: boolean;
}

export function applyAlreadyConsumedGate(ctx: InjectDeliveryCtx): InjectDeliveryCtx {
  return ctx.existingSendStatus === 'consumed' ? decided(ctx, { action: 'noop' }) : ctx;
}

export function applyFailedReopenGate(ctx: InjectDeliveryCtx): InjectDeliveryCtx {
  return ctx.existingSendStatus === 'failed' ? { ...ctx, reopenFailedDelivery: true } : ctx;
}

export function applyDeferAdmissionGate(ctx: InjectDeliveryCtx): InjectDeliveryCtx {
  const admission = decideDeferAdmission({
    deliveryMode: ctx.deliveryMode,
    isBusy: ctx.isBusy,
    inRateLimitCooldown: ctx.inRateLimitCooldown,
    parentTaskLimited: ctx.parentTaskLimited,
  });
  return admission.action === 'defer' ? decided(ctx, admission) : ctx;
}

export function applyInjectContextResetGate(ctx: InjectDeliveryCtx): InjectDeliveryCtx {
  return decided(
    ctx,
    planInjectContextReset({
      inputKind: ctx.inputKind,
      isBusy: ctx.isBusy,
      hasPriorContext: ctx.hasPriorContext,
      slotResetsContext: ctx.slotResetsContext,
      hasActiveDeliveryJob: ctx.hasActiveDeliveryJob,
      hasUnconsumedDeliveredWork: ctx.hasUnconsumedDeliveredWork,
    })
  );
}

export function applyInjectFinalGate(ctx: InjectDeliveryCtx): InjectDeliveryCtx {
  return decided(ctx, { action: 'deliver' });
}

const injectDeliveryRun = decisionRun('message-inject-delivery', [
  applyAlreadyConsumedGate,
  applyFailedReopenGate,
  applyDeferAdmissionGate,
  applyInjectContextResetGate,
  applyInjectFinalGate,
]);

export function decideInjectDelivery(input: InjectDeliveryInput): InjectDeliveryOutcome {
  const ctx = injectDeliveryRun({ ...input, reopenFailedDelivery: false });
  return {
    decision: ctx.decision ?? { action: 'deliver' },
    reopenFailedDelivery: ctx.reopenFailedDelivery,
  };
}

export type TurnEndFlushPlan =
  | { action: 'noop' }
  | { action: 'batch'; uuids: string[]; contextReset: TurnEndFlushContextResetPlan }
  | {
      action: 'each';
      deliver: string[];
      skip: FlushSkipEntry[];
      contextReset: TurnEndFlushContextResetPlan;
    };

export interface TurnEndFlushCtx {
  messages: FlushMessage[];
  activeInJobQueue: ReadonlySet<string>;
  pendingInMemoryUuids: ReadonlySet<string>;
  activeTurnInJobQueue: boolean;
  slotResetsContext: boolean;
  hasPriorContext: boolean;
  pendingTaskInput: boolean;
  flushPlan: FlushDeliveryPlan | null;
  contextReset: TurnEndFlushContextResetPlan | null;
  decision: TurnEndFlushPlan | null;
}

export type TurnEndFlushInput = Omit<TurnEndFlushCtx, 'decision' | 'flushPlan' | 'contextReset'>;

export function applyFlushEmptyGate(ctx: TurnEndFlushCtx): TurnEndFlushCtx {
  return ctx.messages.length === 0 ? decided(ctx, { action: 'noop' }) : ctx;
}

export function applyFlushOwnershipGate(ctx: TurnEndFlushCtx): TurnEndFlushCtx {
  return {
    ...ctx,
    flushPlan: planFlushDelivery({
      messages: ctx.messages,
      activeInJobQueue: ctx.activeInJobQueue,
      pendingInMemoryUuids: ctx.pendingInMemoryUuids,
      activeTurnInJobQueue: ctx.activeTurnInJobQueue,
    }),
  };
}

export function applyFlushContextResetGate(ctx: TurnEndFlushCtx): TurnEndFlushCtx {
  const flushPlan: FlushDeliveryPlan = ctx.flushPlan ?? { action: 'noop' };
  const deliverables =
    flushPlan.action === 'batch'
      ? flushPlan.uuids
      : flushPlan.action === 'each'
        ? flushPlan.deliver
        : [];
  const deliverableSet = new Set(deliverables);
  const taskDeliverableCount =
    ctx.messages.filter((message) => deliverableSet.has(message.uuid) && message.isTaskInput)
      .length + (ctx.pendingTaskInput ? 1 : 0);
  return {
    ...ctx,
    contextReset: planTurnEndFlushContextReset({
      slotResetsContext: ctx.slotResetsContext,
      hasPriorContext: ctx.hasPriorContext,
      hasActiveDeliveryJob: ctx.activeInJobQueue.size > 0,
      taskDeliverableCount,
    }),
  };
}

export function applyFlushFinalGate(ctx: TurnEndFlushCtx): TurnEndFlushCtx {
  const flushPlan: FlushDeliveryPlan = ctx.flushPlan ?? { action: 'noop' };
  const contextReset: TurnEndFlushContextResetPlan = ctx.contextReset ?? {
    action: 'flush_without_clear',
  };
  if (flushPlan.action === 'batch') {
    return decided(ctx, { action: 'batch', uuids: flushPlan.uuids, contextReset });
  }
  if (flushPlan.action === 'each') {
    return decided(ctx, {
      action: 'each',
      deliver: flushPlan.deliver,
      skip: flushPlan.skip,
      contextReset,
    });
  }
  return decided(ctx, { action: 'noop' });
}

const turnEndFlushRun = decisionRun('message-turn-end-flush', [
  applyFlushEmptyGate,
  applyFlushOwnershipGate,
  applyFlushContextResetGate,
  applyFlushFinalGate,
]);

export function decideTurnEndFlush(input: TurnEndFlushInput): TurnEndFlushPlan {
  const ctx = turnEndFlushRun({ ...input, flushPlan: null, contextReset: null });
  return ctx.decision ?? { action: 'noop' };
}

export type { TurnCompletionInput, TurnCompletionOutcome } from './turn-outcome-classification';
export {
  classifyTurnCompletion,
  decideReconcileAdmission,
  selectStrandedDeliveries,
  shouldRearmSpuriousTurnEnd,
} from './turn-outcome-classification';

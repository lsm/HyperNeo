import type { SendStatus } from '../../storage/repositories/sdk-message-repository.ts';
import { decisionRun } from '../space/runtime/decision-pipeline.ts';
import { MESSAGE_DELIVERY_PARK_MS, RESUME_CHOICE_PARK_BUDGET } from './message-delivery.ts';
import type {
  InjectContextResetPlan,
  TurnEndFlushContextResetPlan,
} from './context-reset-planner.ts';
import { planInjectContextReset, planTurnEndFlushContextReset } from './context-reset-planner.ts';
import type { FlushDeliveryPlan, FlushMessage, FlushSkipEntry } from './message-ownership-gates.ts';
import { decideDeferAdmission, planFlushDelivery } from './message-ownership-gates.ts';

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

export type { TurnCompletionInput, TurnCompletionOutcome } from './turn-outcome-classification.ts';
export {
  classifyTurnCompletion,
  decideReconcileAdmission,
  selectStrandedDeliveries,
  shouldRearmSpuriousTurnEnd,
} from './turn-outcome-classification.ts';

export type BlockedTurnRouteDecision =
  | { action: 'requeue_now' }
  | { action: 'dead_letter'; reason: string }
  | { action: 'park'; retryAt: number; reason: string };

export const RESUME_CHOICE_DEAD_LETTER_REASON =
  'Turn parked on sdk_resume_choice past its budget — answer the resume prompt or resend';

const RESUME_CHOICE_PARK_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];

export function resumeChoiceParkDelayMs(parkCount: number): number {
  const idx = Math.min(Math.max(parkCount, 0), RESUME_CHOICE_PARK_BACKOFF_MS.length - 1);
  return RESUME_CHOICE_PARK_BACKOFF_MS[idx];
}

export interface BlockedTurnRouteCtx {
  outcome: 'blocked';
  parkCount: number;
  resumeChoiceResolved: boolean;
  now: number;
  decision: BlockedTurnRouteDecision | null;
}

export type BlockedTurnRouteInput = Omit<BlockedTurnRouteCtx, 'decision'>;

export function applyResolvedChoiceGate(ctx: BlockedTurnRouteCtx): BlockedTurnRouteCtx {
  return ctx.resumeChoiceResolved ? decided(ctx, { action: 'requeue_now' }) : ctx;
}

export function applyResumeChoiceBudgetGate(ctx: BlockedTurnRouteCtx): BlockedTurnRouteCtx {
  return ctx.parkCount >= RESUME_CHOICE_PARK_BUDGET
    ? decided(ctx, { action: 'dead_letter', reason: RESUME_CHOICE_DEAD_LETTER_REASON })
    : ctx;
}

export function applyParkBackoffFinalGate(ctx: BlockedTurnRouteCtx): BlockedTurnRouteCtx {
  return decided(ctx, {
    action: 'park',
    retryAt: ctx.now + resumeChoiceParkDelayMs(ctx.parkCount),
    reason: 'sdk_resume_choice',
  });
}

const blockedTurnRouteRun = decisionRun('message-blocked-turn-route', [
  applyResolvedChoiceGate,
  applyResumeChoiceBudgetGate,
  applyParkBackoffFinalGate,
]);

export function routeBlockedTurn(input: BlockedTurnRouteInput): BlockedTurnRouteDecision {
  const ctx = blockedTurnRouteRun(input);
  return (
    ctx.decision ?? {
      action: 'park',
      retryAt: input.now + MESSAGE_DELIVERY_PARK_MS,
      reason: 'sdk_resume_choice',
    }
  );
}

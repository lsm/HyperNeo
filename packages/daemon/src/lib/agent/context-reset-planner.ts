export type InjectContextResetReason =
  | 'not_task_input'
  | 'session_busy'
  | 'no_prior_context'
  | 'slot_not_reset'
  | 'delivery_job_active'
  | 'unconsumed_work_pending';

export type InjectContextResetPlan =
  | { action: 'clear_before_deliver' }
  | { action: 'deliver_without_clear'; reason: InjectContextResetReason };

export type TurnEndFlushContextResetPlan =
  | { action: 'clear_then_flush' }
  | { action: 'flush_without_clear'; reason?: 'active_delivery_job' };

export function planInjectContextReset(args: {
  inputKind: string;
  isBusy: boolean;
  hasPriorContext: boolean;
  slotResetsContext: boolean;
  hasActiveDeliveryJob: boolean;
  hasUnconsumedDeliveredWork: boolean;
}): InjectContextResetPlan {
  if (args.inputKind !== 'task') {
    return { action: 'deliver_without_clear', reason: 'not_task_input' };
  }
  if (args.isBusy) {
    return { action: 'deliver_without_clear', reason: 'session_busy' };
  }
  if (!args.hasPriorContext) {
    return { action: 'deliver_without_clear', reason: 'no_prior_context' };
  }
  if (!args.slotResetsContext) {
    return { action: 'deliver_without_clear', reason: 'slot_not_reset' };
  }
  if (args.hasActiveDeliveryJob) {
    return { action: 'deliver_without_clear', reason: 'delivery_job_active' };
  }
  if (args.hasUnconsumedDeliveredWork) {
    return { action: 'deliver_without_clear', reason: 'unconsumed_work_pending' };
  }
  return { action: 'clear_before_deliver' };
}

export function planTurnEndFlushContextReset(args: {
  slotResetsContext: boolean;
  hasPriorContext: boolean;
  hasActiveDeliveryJob: boolean;
  taskDeliverableCount: number;
}): TurnEndFlushContextResetPlan {
  if (
    args.slotResetsContext &&
    args.hasPriorContext &&
    !args.hasActiveDeliveryJob &&
    args.taskDeliverableCount > 0
  ) {
    return { action: 'clear_then_flush' };
  }
  if (args.slotResetsContext && args.hasPriorContext && args.hasActiveDeliveryJob) {
    return { action: 'flush_without_clear', reason: 'active_delivery_job' };
  }
  return { action: 'flush_without_clear' };
}

type InjectContextResetGuardCtx = {
  inputKind: string;
  isBusy: boolean;
  hasPriorContext: boolean;
  slotResetsContext: boolean;
  hasActiveDeliveryJob: boolean;
  hasUnconsumedDeliveredWork: boolean;
  decision: InjectContextResetPlan | { action: string } | null;
};

type FlushContextResetGuardCtx = {
  slotResetsContext: boolean;
  hasPriorContext: boolean;
  hasActiveDeliveryJob: boolean;
  taskDeliverableCount: number;
  contextReset: TurnEndFlushContextResetPlan | null;
};

function deliverWithoutClear(reason: InjectContextResetReason): InjectContextResetPlan {
  return { action: 'deliver_without_clear', reason };
}

export function applyNotTaskInputGate<Ctx extends InjectContextResetGuardCtx>(ctx: Ctx): Ctx {
  return ctx.inputKind === 'task'
    ? ctx
    : { ...ctx, decision: deliverWithoutClear('not_task_input') };
}

export function applyBusyGate<Ctx extends InjectContextResetGuardCtx>(ctx: Ctx): Ctx {
  return ctx.isBusy ? { ...ctx, decision: deliverWithoutClear('session_busy') } : ctx;
}

export function applyNoPriorContextGate<Ctx extends InjectContextResetGuardCtx>(ctx: Ctx): Ctx {
  return ctx.hasPriorContext ? ctx : { ...ctx, decision: deliverWithoutClear('no_prior_context') };
}

export function applySlotNotResetGate<Ctx extends InjectContextResetGuardCtx>(ctx: Ctx): Ctx {
  return ctx.slotResetsContext ? ctx : { ...ctx, decision: deliverWithoutClear('slot_not_reset') };
}

export function applyActiveDeliveryJobGate<Ctx extends InjectContextResetGuardCtx>(ctx: Ctx): Ctx;
export function applyActiveDeliveryJobGate<Ctx extends FlushContextResetGuardCtx>(ctx: Ctx): Ctx;
export function applyActiveDeliveryJobGate(
  ctx: InjectContextResetGuardCtx | FlushContextResetGuardCtx
): InjectContextResetGuardCtx | FlushContextResetGuardCtx {
  if (!ctx.hasActiveDeliveryJob) return ctx;
  if ('contextReset' in ctx) {
    return ctx.contextReset === null && ctx.slotResetsContext && ctx.hasPriorContext
      ? { ...ctx, contextReset: { action: 'flush_without_clear', reason: 'active_delivery_job' } }
      : ctx;
  }
  return { ...ctx, decision: deliverWithoutClear('delivery_job_active') };
}

export function applyUnconsumedWorkGate<Ctx extends InjectContextResetGuardCtx>(ctx: Ctx): Ctx {
  return ctx.hasUnconsumedDeliveredWork
    ? { ...ctx, decision: deliverWithoutClear('unconsumed_work_pending') }
    : ctx;
}

export function applyClearBeforeDeliverGate<Ctx extends InjectContextResetGuardCtx>(ctx: Ctx): Ctx {
  return { ...ctx, decision: { action: 'clear_before_deliver' } };
}

export function applyClearThenFlushGate<Ctx extends FlushContextResetGuardCtx>(ctx: Ctx): Ctx {
  return ctx.slotResetsContext &&
    ctx.hasPriorContext &&
    !ctx.hasActiveDeliveryJob &&
    ctx.taskDeliverableCount > 0
    ? { ...ctx, contextReset: { action: 'clear_then_flush' } }
    : ctx;
}

export function applyFlushWithoutClearGate<Ctx extends FlushContextResetGuardCtx>(ctx: Ctx): Ctx {
  return ctx.contextReset !== null
    ? ctx
    : { ...ctx, contextReset: { action: 'flush_without_clear' } };
}

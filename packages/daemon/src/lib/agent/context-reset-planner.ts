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
  | { action: 'flush_without_clear' };

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
  return { action: 'flush_without_clear' };
}

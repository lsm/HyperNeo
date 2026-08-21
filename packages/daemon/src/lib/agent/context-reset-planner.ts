export type InjectContextResetReason =
  | 'not_task_input'
  | 'session_busy'
  | 'no_prior_context'
  | 'slot_not_reset'
  | 'delivery_job_active';

export type InjectContextResetPlan =
  | { action: 'clear_before_deliver' }
  | { action: 'deliver_without_clear'; reason: InjectContextResetReason };

export type TurnEndFlushContextResetPlan = { action: 'flush_without_clear' };

export function planInjectContextReset(args: {
  inputKind: string;
  isBusy: boolean;
  hasPriorContext: boolean;
  slotResetsContext: boolean;
  hasActiveDeliveryJob: boolean;
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
  return { action: 'clear_before_deliver' };
}

export function planTurnEndFlushContextReset(_args: {
  slotResetsContext: boolean;
  deliverableCount: number;
}): TurnEndFlushContextResetPlan {
  return { action: 'flush_without_clear' };
}

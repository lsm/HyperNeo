import type { SendStatus } from '../../storage/repositories/sdk-message-repository.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type {
  InjectContextResetPlan,
  TurnEndFlushContextResetPlan,
} from './context-reset-planner.ts';
import { planInjectContextReset, planTurnEndFlushContextReset } from './context-reset-planner.ts';
import type { FlushDeliveryPlan, FlushMessage, FlushSkipEntry } from './message-ownership-gates.ts';
import { decideDeferAdmission, planFlushDelivery } from './message-ownership-gates.ts';

export type InjectDeliveryDecision =
  | { action: 'noop' }
  | { action: 'defer' }
  | InjectContextResetPlan
  | { action: 'deliver' };

export interface InjectDeliveryInput {
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
}

export interface InjectDeliveryOutcome {
  decision: InjectDeliveryDecision;
  reopenFailedDelivery: boolean;
}

export function shouldReopenFailedDelivery(input: InjectDeliveryInput): boolean {
  return input.existingSendStatus === 'failed';
}

export function gateDeliveryNotConsumed(
  input: InjectDeliveryInput
): { value: InjectDeliveryInput } | { reason: InjectDeliveryDecision } {
  return input.existingSendStatus === 'consumed'
    ? { reason: { action: 'noop' } }
    : { value: input };
}

export function gateDeferredAdmission(
  input: InjectDeliveryInput
): { value: InjectDeliveryInput } | { reason: InjectDeliveryDecision } {
  const admission = decideDeferAdmission({
    deliveryMode: input.deliveryMode,
    isBusy: input.isBusy,
    inRateLimitCooldown: input.inRateLimitCooldown,
    parentTaskLimited: input.parentTaskLimited,
  });
  return admission.action === 'defer' ? { reason: { action: 'defer' } } : { value: input };
}

export function classifyInjectDelivery(input: InjectDeliveryInput): InjectDeliveryDecision {
  return planInjectContextReset({
    inputKind: input.inputKind,
    isBusy: input.isBusy,
    hasPriorContext: input.hasPriorContext,
    slotResetsContext: input.slotResetsContext,
    hasActiveDeliveryJob: input.hasActiveDeliveryJob,
    hasUnconsumedDeliveredWork: input.hasUnconsumedDeliveredWork,
  });
}

export const runInjectDelivery = (superpipe({})('message-inject-delivery') as PipelineAPI)
  .input(['input'])
  .pipe(gateDeliveryNotConsumed, 'input', 'result:admission')
  .pipe(gateDeferredAdmission, 'admission', 'result:admission')
  .pipe(finalizeInjectDelivery, 'admission', 'result:admission')
  .end('admission') as (input: InjectDeliveryInput) => InjectDeliveryOutcome;

function finalizeInjectDelivery(
  input: InjectDeliveryInput
): { value: InjectDeliveryOutcome } | { reason: InjectDeliveryDecision } {
  return {
    value: {
      decision: classifyInjectDelivery(input),
      reopenFailedDelivery: shouldReopenFailedDelivery(input),
    },
  };
}

export function decideInjectDelivery(input: InjectDeliveryInput): InjectDeliveryOutcome {
  const outcome = runInjectDelivery(input);
  return 'decision' in outcome
    ? outcome
    : { decision: outcome, reopenFailedDelivery: shouldReopenFailedDelivery(input) };
}

export type TurnEndFlushPlan =
  | { action: 'noop' }
  | {
      action: 'each';
      deliver: string[];
      skip: FlushSkipEntry[];
      contextReset: TurnEndFlushContextResetPlan;
    };

export interface TurnEndFlushInput {
  messages: FlushMessage[];
  activeInJobQueue: ReadonlySet<string>;
  slotResetsContext: boolean;
  hasPriorContext: boolean;
  pendingTaskInput: boolean;
}

function planFlushContextReset(input: TurnEndFlushInput, flushPlan: FlushDeliveryPlan) {
  const deliverables = flushPlan.action === 'each' ? flushPlan.deliver : [];
  const deliverableSet = new Set(deliverables);
  const taskDeliverableCount =
    input.messages.filter((message) => deliverableSet.has(message.uuid) && message.isTaskInput)
      .length + (input.pendingTaskInput ? 1 : 0);
  return planTurnEndFlushContextReset({
    slotResetsContext: input.slotResetsContext,
    hasPriorContext: input.hasPriorContext,
    hasActiveDeliveryJob: input.activeInJobQueue.size > 0,
    taskDeliverableCount,
  });
}

export function gateFlushHasMessages(
  input: TurnEndFlushInput
): { value: TurnEndFlushInput } | { reason: TurnEndFlushPlan } {
  return input.messages.length === 0 ? { reason: { action: 'noop' } } : { value: input };
}

export function classifyTurnEndFlush(input: TurnEndFlushInput): TurnEndFlushPlan {
  const flushPlan = planFlushDelivery({
    messages: input.messages,
    activeInJobQueue: input.activeInJobQueue,
  });
  if (flushPlan.action !== 'each') return { action: 'noop' };
  return {
    action: 'each',
    deliver: flushPlan.deliver,
    skip: flushPlan.skip,
    contextReset: planFlushContextReset(input, flushPlan),
  };
}

export function finalizeTurnEndFlush(
  input: TurnEndFlushInput
): { value: TurnEndFlushPlan } | { reason: TurnEndFlushPlan } {
  return { value: classifyTurnEndFlush(input) };
}

export const runTurnEndFlush = (superpipe({})('message-turn-end-flush') as PipelineAPI)
  .input(['input'])
  .pipe(gateFlushHasMessages, 'input', 'result:flush')
  .pipe(finalizeTurnEndFlush, 'flush', 'result:flush')
  .end('flush') as (input: TurnEndFlushInput) => TurnEndFlushPlan;

export function decideTurnEndFlush(input: TurnEndFlushInput): TurnEndFlushPlan {
  const outcome = runTurnEndFlush(input);
  return outcome ?? { action: 'noop' };
}

export {
  decideReconcileAdmission,
  selectStrandedDeliveries,
} from './turn-outcome-classification.ts';

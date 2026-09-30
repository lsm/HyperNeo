import superpipe, { type PipelineAPI } from 'superpipe';
import type { ExternalEventTaskDecision } from './admission-gates.ts';

export type ExternalEventDeliveryDecision =
  | { action: 'skip' }
  | { action: 'skipClaimConflict' }
  | { action: 'failDelivery'; reason: string }
  | { action: 'deferPausedSpace' }
  | { action: 'deferStoppedTask' }
  | { action: 'deliverLiveSession' }
  | { action: 'deliverStaleSession' }
  | {
      action: 'queueForActivation';
      reason: string;
      preserveAttemptCount?: boolean;
      retryUnlessPaused?: boolean;
    }
  | { action: 'deferNotActive' }
  | { action: 'activateTarget' };

export interface ExternalEventDeliveryInput {
  deliveryTerminal: boolean;
  deliveryInFlight: boolean;
  subscriptionActive: boolean;
  taskDecision: ExternalEventTaskDecision;
  targetHasSession: boolean;
  targetSessionLive: boolean;
  targetSpacePaused: boolean;
  executionPendingActivation: boolean;
}

export interface PostActivationDeliveryInput {
  activationError: string | null;
  activatedTargetFound: boolean;
  activatedHasSession: boolean;
  activatedSessionLive: boolean;
}

export function classifyExternalEventDelivery(
  input: ExternalEventDeliveryInput
): ExternalEventDeliveryDecision {
  if (input.deliveryTerminal) return { action: 'skip' };
  if (input.deliveryInFlight) return { action: 'skipClaimConflict' };
  if (!input.subscriptionActive) {
    return { action: 'failDelivery', reason: 'subscription_no_longer_active' };
  }
  if (input.taskDecision.action === 'hold') return { action: 'deferStoppedTask' };
  if (input.taskDecision.action !== 'deliver') {
    return { action: 'failDelivery', reason: input.taskDecision.reason };
  }
  if (input.targetHasSession) {
    if (!input.targetSessionLive) return { action: 'deliverStaleSession' };
    if (input.targetSpacePaused) return { action: 'deferPausedSpace' };
    return { action: 'deliverLiveSession' };
  }
  if (input.executionPendingActivation) {
    return {
      action: 'queueForActivation',
      reason: 'deliveryMode:defer; node_execution_pending',
      preserveAttemptCount: true,
    };
  }
  return { action: 'activateTarget' };
}

export function classifyPostActivationDelivery(
  input: PostActivationDeliveryInput
): ExternalEventDeliveryDecision {
  if (input.activationError !== null) {
    return {
      action: 'queueForActivation',
      reason: `deliveryMode:defer; activation_failed; ${input.activationError}`,
    };
  }
  if (!input.activatedTargetFound) {
    return {
      action: 'queueForActivation',
      reason: 'deliveryMode:defer; node_execution_not_active',
      retryUnlessPaused: true,
    };
  }
  if (!input.activatedHasSession) return { action: 'deferNotActive' };
  if (!input.activatedSessionLive) return { action: 'deliverStaleSession' };
  return { action: 'deliverLiveSession' };
}

export const decideExternalEventDelivery = (superpipe({})('external-event-delivery') as PipelineAPI)
  .input(['input'])
  .pipe(classifyExternalEventDelivery, 'input', 'decision')
  .end('decision') as (input: ExternalEventDeliveryInput) => ExternalEventDeliveryDecision;

export const decidePostActivationDelivery = (
  superpipe({})('external-event-post-activation') as PipelineAPI
)
  .input(['input'])
  .pipe(classifyPostActivationDelivery, 'input', 'decision')
  .end('decision') as (input: PostActivationDeliveryInput) => ExternalEventDeliveryDecision;

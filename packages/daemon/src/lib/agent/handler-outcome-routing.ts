import type { DeliveryOutcome } from './message-delivery.ts';

export type HandlerJobResult =
  | { outcome: 'completed' }
  | { outcome: 'aborted' }
  | { parked: string; retryAt: number };

export type HandlerOutcomeRoute =
  | { deadLetter: string }
  | {
      mutation: 'none' | 'requeue';
      retryAt?: number;
      settleSkipped: boolean;
      result: HandlerJobResult;
    };

export function routeDriveTurnOutcome(result: DeliveryOutcome): HandlerOutcomeRoute {
  if (result.outcome === 'completed') {
    return { mutation: 'none', settleSkipped: false, result: { outcome: 'completed' } };
  }
  if (result.outcome === 'aborted') {
    return { mutation: 'none', settleSkipped: true, result: { outcome: 'aborted' } };
  }
  if (result.outcome === 'blocked') {
    const parked =
      result.reason === 'context_clear_boundary'
        ? 'context_clear_boundary'
        : result.reason === 'limit_recovery'
          ? 'limit_recovery'
          : 'sdk_resume_choice';
    return {
      mutation: 'requeue',
      retryAt: result.retryAt,
      settleSkipped: false,
      result: { parked, retryAt: result.retryAt },
    };
  }
  return { mutation: 'none', settleSkipped: false, result: { outcome: 'completed' } };
}

export function routeFeedSteerOutcome(result: DeliveryOutcome): HandlerOutcomeRoute {
  return routeDriveTurnOutcome(result);
}

import {
  type DriveTurnOutcome,
  type FeedSteerOutcome,
  isUniqueConstraintError,
  MAX_ACP_STEER_PARKS,
  MAX_STEER_PARKS,
  MESSAGE_DELIVERY_PARK_MS,
  RESUME_CHOICE_PARK_BUDGET,
} from './message-delivery.ts';
import {
  RESUME_CHOICE_DEAD_LETTER_REASON,
  resumeChoiceParkDelayMs,
  routeBlockedTurn,
} from './message-delivery-pipeline.ts';

export { RESUME_CHOICE_DEAD_LETTER_REASON, resumeChoiceParkDelayMs };

export type HandlerJobResult =
  | { outcome: 'completed'; skipped?: 'turn_terminated' }
  | { outcome: 'aborted' }
  | { outcome: 'consumed' }
  | { outcome: 'superseded'; promoted: 'turn' | 'steer' }
  | {
      parked:
        | 'sdk_resume_choice'
        | 'limit_recovery'
        | 'turn_blocked'
        | 'turn_blocked_gate_open'
        | 'acp_awaiting_acceptance';
      retryAt: number;
    };

export type HandlerOutcomeRoute =
  | { deadLetter: string }
  | {
      mutation: 'none' | 'requeue' | 'requeueParked' | 'requeueAs';
      retryAt?: number;
      requeueRole?: 'turn' | 'steer';
      settleSkipped: boolean;
      reclaimSkip?: 'turn_terminated';
      result: HandlerJobResult;
    };

export function routeDriveTurnOutcome(
  result: DriveTurnOutcome,
  args: { parkCount: number; now: number; resumeChoiceResolved?: boolean }
): HandlerOutcomeRoute {
  if (result.outcome === 'blocked') {
    const decision = routeBlockedTurn({
      outcome: 'blocked',
      parkCount: args.parkCount,
      resumeChoiceResolved: args.resumeChoiceResolved === true,
      now: args.now,
    });
    if (decision.action === 'dead_letter') {
      return { deadLetter: decision.reason };
    }
    if (decision.action === 'requeue_now') {
      const retryAt = args.now;
      return {
        mutation: 'requeue',
        retryAt,
        settleSkipped: false,
        result: { parked: 'sdk_resume_choice', retryAt },
      };
    }
    return {
      mutation: 'requeueParked',
      retryAt: decision.retryAt,
      settleSkipped: false,
      result: { parked: 'sdk_resume_choice', retryAt: decision.retryAt },
    };
  }
  if (result.outcome === 'recovery_pending') {
    return {
      mutation: 'requeue',
      retryAt: result.retryAt,
      settleSkipped: false,
      result: { parked: 'limit_recovery', retryAt: result.retryAt },
    };
  }
  if (result.outcome === 'aborted') {
    return { mutation: 'none', settleSkipped: true, result: { outcome: 'aborted' } };
  }
  if (result.outcome === 'turn_terminated') {
    return {
      mutation: 'none',
      settleSkipped: true,
      reclaimSkip: 'turn_terminated',
      result: { outcome: 'completed', skipped: 'turn_terminated' },
    };
  }
  return { mutation: 'none', settleSkipped: false, result: { outcome: 'completed' } };
}

export function routeFeedSteerOutcome(
  result: FeedSteerOutcome,
  args: {
    parkCount: number;
    waitingForInput: boolean;
    resumeChoicePending?: boolean;
    now: number;
  }
): HandlerOutcomeRoute {
  if (result.outcome === 'aborted') {
    return { mutation: 'none', settleSkipped: true, result: { outcome: 'aborted' } };
  }
  if (result.outcome === 'park') {
    if (args.waitingForInput && args.resumeChoicePending === true) {
      if (args.parkCount >= RESUME_CHOICE_PARK_BUDGET) {
        return { deadLetter: RESUME_CHOICE_DEAD_LETTER_REASON };
      }
      const retryAt = args.now + resumeChoiceParkDelayMs(args.parkCount);
      return {
        mutation: 'requeueParked',
        retryAt,
        settleSkipped: false,
        result: { parked: 'sdk_resume_choice', retryAt },
      };
    }
    if (args.waitingForInput) {
      const retryAt = args.now + MESSAGE_DELIVERY_PARK_MS;
      return {
        mutation: 'requeue',
        retryAt,
        settleSkipped: false,
        result: { parked: 'turn_blocked_gate_open', retryAt },
      };
    }
    if (args.parkCount >= MAX_STEER_PARKS) {
      return { deadLetter: 'Steer parked past its budget — owning turn never unblocked' };
    }
    const retryAt = args.now + MESSAGE_DELIVERY_PARK_MS;
    return {
      mutation: 'requeueParked',
      retryAt,
      settleSkipped: false,
      result: { parked: 'turn_blocked', retryAt },
    };
  }
  if (result.outcome === 'awaiting_acceptance') {
    if (args.parkCount >= MAX_ACP_STEER_PARKS) {
      return {
        deadLetter: 'ACP steer awaited acceptance past its budget — subprocess never accepted',
      };
    }
    const retryAt = args.now + MESSAGE_DELIVERY_PARK_MS;
    return {
      mutation: 'requeueParked',
      retryAt,
      settleSkipped: false,
      result: { parked: 'acp_awaiting_acceptance', retryAt },
    };
  }
  if (result.outcome === 'promote') {
    return {
      mutation: 'requeueAs',
      requeueRole: 'turn',
      retryAt: args.now,
      settleSkipped: false,
      result: { outcome: 'superseded', promoted: 'turn' },
    };
  }
  return { mutation: 'none', settleSkipped: false, result: { outcome: 'consumed' } };
}

export function routeSteerPromoteFallback(
  err: unknown,
  args: { now: number }
): HandlerOutcomeRoute | null {
  if (!isUniqueConstraintError(err)) return null;
  const retryAt = args.now + MESSAGE_DELIVERY_PARK_MS;
  return {
    mutation: 'requeueAs',
    requeueRole: 'steer',
    retryAt,
    settleSkipped: false,
    result: { outcome: 'superseded', promoted: 'steer' },
  };
}

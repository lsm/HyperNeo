import { isRetryableErrorResultSubtype, isTerminalTurnError } from './message-delivery.ts';

export type TurnCompletionInput = {
  producedResult: boolean;
  turnError: {
    userMessage?: string;
    message?: string;
    category?: string;
    recoverable: boolean;
  } | null;
  errorResultSubtype: string | null;
  deliveryTurnStalled: boolean;
  claimGuardHeld?: boolean;
};

export type TurnCompletionOutcome =
  | { outcome: 'completed' }
  | { outcome: 'terminal_error'; detail: string; category?: string }
  | { outcome: 'recoverable_error'; detail: string; category?: string; reopenForRetry: boolean };

export function classifyTurnCompletion(args: TurnCompletionInput): TurnCompletionOutcome {
  if (args.producedResult) {
    return { outcome: 'completed' };
  }

  const detail =
    args.turnError?.userMessage ||
    args.turnError?.message ||
    (args.errorResultSubtype
      ? `Turn ended with a terminal error (${args.errorResultSubtype})`
      : args.deliveryTurnStalled
        ? 'No response from the model — resetting and retrying'
        : 'Turn ended without a response');

  if (args.turnError && isTerminalTurnError(args.turnError)) {
    return { outcome: 'terminal_error', detail, category: args.turnError.category };
  }

  if (
    !args.turnError &&
    args.errorResultSubtype &&
    !isRetryableErrorResultSubtype(args.errorResultSubtype)
  ) {
    return { outcome: 'terminal_error', detail, category: args.errorResultSubtype };
  }

  return {
    outcome: 'recoverable_error',
    detail,
    category: args.turnError?.category,
    reopenForRetry: args.claimGuardHeld ?? true,
  };
}

export function shouldRearmSpuriousTurnEnd(args: {
  feedAcknowledged: boolean;
  turnEndFired: boolean;
  queryEnded: boolean;
  withinGraceMs: boolean;
  graceRearms: number;
  hasTerminalResult: boolean;
}): boolean {
  return (
    args.feedAcknowledged &&
    args.turnEndFired &&
    !args.queryEnded &&
    args.withinGraceMs &&
    args.graceRearms < 2 &&
    !args.hasTerminalResult
  );
}

export function decideReconcileAdmission(args: {
  processingStatus: string;
}): { action: 'skip' } | { action: 'run' } {
  if (
    args.processingStatus === 'processing' ||
    args.processingStatus === 'queued' ||
    args.processingStatus === 'waiting_for_input'
  ) {
    return { action: 'skip' };
  }
  return { action: 'run' };
}

export function selectStrandedDeliveries(
  enqueued: Array<{ uuid?: string }>,
  activeInJobQueue: ReadonlySet<string>,
  isInFlight?: (uuid: string) => boolean
): string[] {
  const stranded: string[] = [];
  for (const msg of enqueued) {
    const uuid = msg.uuid;
    if (
      typeof uuid === 'string' &&
      uuid.length > 0 &&
      !activeInJobQueue.has(uuid) &&
      !(isInFlight?.(uuid) ?? false)
    ) {
      stranded.push(uuid);
    }
  }
  return stranded;
}

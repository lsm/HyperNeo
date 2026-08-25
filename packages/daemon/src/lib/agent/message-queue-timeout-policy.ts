export const QUEUE_TIMEOUT_ERROR_NAME = 'MessageQueueTimeoutError';

export function buildQueueTimeoutError(args: { messageId: string; timeoutMs: number }): Error {
  const error = new Error(
    `Message queue timeout: SDK did not consume message ${args.messageId} within ${args.timeoutMs / 1000}s. ` +
      `This usually indicates an SDK internal error. Please try again or create a new session.`
  );
  error.name = QUEUE_TIMEOUT_ERROR_NAME;
  return error;
}

export type QueueTimeoutDecision =
  | { action: 'none' }
  | { action: 'reject'; removeFrom: 'pending' | 'claimed' | 'yielded' }
  | { action: 'resolve'; removeFrom: 'yielded' };

export function resolveQueueTimeout(args: {
  pending: boolean;
  claimed: boolean;
  yielded: boolean;
  durable: boolean;
}): QueueTimeoutDecision {
  if (args.pending) return { action: 'reject', removeFrom: 'pending' };
  if (args.claimed) return { action: 'reject', removeFrom: 'claimed' };
  if (args.yielded) {
    return args.durable
      ? { action: 'resolve', removeFrom: 'yielded' }
      : { action: 'reject', removeFrom: 'yielded' };
  }
  return { action: 'none' };
}

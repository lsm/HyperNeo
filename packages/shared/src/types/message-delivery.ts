export type MessageDeliveryStatus = 'queued' | 'processing' | 'retrying' | 'delivered' | 'failed';

export interface MessageDeliveryRetryInfo {
  count: number;
  runAt?: number;
  maxRetries?: number;
}

export type MessageSendStatus = 'deferred' | 'enqueued' | 'submitted' | 'consumed' | 'failed';

export function sendStatusToDeliveryStatus(
  sendStatus: MessageSendStatus | string | null | undefined,
  options?: { retrying?: boolean }
): MessageDeliveryStatus | null {
  const retrying = options?.retrying === true;
  switch (sendStatus ?? 'consumed') {
    case 'deferred':
    case 'enqueued':
      return retrying ? 'retrying' : 'queued';
    case 'submitted':
      return retrying ? 'retrying' : 'processing';
    case 'consumed':
      return retrying ? 'retrying' : 'delivered';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

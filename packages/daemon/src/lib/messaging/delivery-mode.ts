import type { MessageDeliveryMode } from '@hyperneo/shared';

export function deliveryModeFromFailureReason(
  _failureReason: string | null | undefined
): MessageDeliveryMode {
  return 'defer';
}

import type { MessageDeliveryMode } from '@hyperneo/shared';

/**
 * Recovers the delivery mode for a pending external-event delivery.
 *
 * Always `defer`. External events deliver on the "next" boundary — insert
 * when idle, queue and replay at the next idle point, never inject
 * mid-work — so there is no population for which `immediate` recovery is
 * correct:
 *
 * - New dispatches are always handed off in `defer` mode.
 * - Legacy rows persisted before the `deliveryMode:` prefixes existed carry
 *   a null or bare reason and previously recovered as `immediate` — the
 *   exact mid-work-injection failure this mode system exists to prevent.
 * - Legacy rows carrying an explicit `deliveryMode:immediate;` prefix (the
 *   old fresh-delivery failure encoding) are normalized too: the prefix
 *   records how a PRE-upgrade dispatch was attempted, not an intent that
 *   survives the always-next-idle behavior.
 */
export function deliveryModeFromFailureReason(
  _failureReason: string | null | undefined
): MessageDeliveryMode {
  return 'defer';
}

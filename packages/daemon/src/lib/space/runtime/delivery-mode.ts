import type { MessageDeliveryMode } from '@neokai/shared';

/**
 * Prefix SpaceRuntime writes onto a parked external-event delivery's
 * `failureReason` when it must be re-dispatched in `defer` mode after
 * rehydration. Only this marker is opt-in — the reader treats every other
 * value (including `deliveryMode:immediate;…` and `null`) as `immediate`.
 */
const DEFER_DELIVERY_MODE_PREFIX = 'deliveryMode:defer;';

/**
 * Recovers the delivery mode persisted in a pending external-event delivery's
 * `failureReason`.
 *
 * When SpaceRuntime parks a delivery for later re-dispatch it encodes the mode
 * as a `deliveryMode:<mode>; …` prefix. Only `defer` is distinguished; anything
 * else (`null`, `deliveryMode:immediate;…`, or an unrelated failure reason)
 * resolves to the `immediate` default — matching the inline check previously
 * duplicated across the activation flush and requeue paths.
 */
export function deliveryModeFromFailureReason(
  failureReason: string | null | undefined
): MessageDeliveryMode {
  return failureReason?.startsWith(DEFER_DELIVERY_MODE_PREFIX) ? 'defer' : 'immediate';
}

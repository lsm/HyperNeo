import type { MessageDeliveryMode } from '@hyperneo/shared';

/**
 * Prefix recorded on a persisted delivery that was explicitly handed off in
 * `immediate` mode. Only rows carrying this marker replay as `immediate`;
 * everything else — the `deliveryMode:defer;` marker SpaceRuntime writes on
 * parked deliveries, bare legacy reasons, and null — recovers as `defer`.
 */
const IMMEDIATE_DELIVERY_MODE_PREFIX = 'deliveryMode:immediate;';

/**
 * Recovers the delivery mode persisted in a pending external-event delivery's
 * `failureReason`.
 *
 * Default is `defer`: a pending delivery whose reason carries no explicit
 * marker — `null`, a bare legacy reason (`node_execution_not_active`,
 * `activation_failed; …`), or any unrecognized string — must NOT replay as
 * `immediate`, which would steer an already-processing kickoff mid-turn (the
 * exact failure the defer-to-next-idle change exists to eliminate). This also
 * normalizes durable rows persisted by pre-upgrade code before the
 * `deliveryMode:` prefixes existed: they recovered as `immediate` under the
 * old null-fallback and could inject mid-work after deployment.
 */
export function deliveryModeFromFailureReason(
  failureReason: string | null | undefined
): MessageDeliveryMode {
  return failureReason?.startsWith(IMMEDIATE_DELIVERY_MODE_PREFIX) ? 'immediate' : 'defer';
}

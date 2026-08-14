/**
 * User-facing message-delivery lifecycle for a persisted SDK user message.
 *
 * Task #862 (phase 4 of message-delivery reliability): surfaces the durable
 * delivery state established in #859–#861 so users can distinguish queued /
 * processing / retrying / failed messages explicitly, rather than inferring
 * state from system/init messages.
 *
 * Derived from the raw `sdk_messages.send_status` column plus, for the
 * "retrying" state, the active `message_delivery` job's `retry_count`. The
 * mapping lives in {@link sendStatusToDeliveryStatus} so the daemon feed and
 * any UI consumer share one source of truth.
 *
 * This is intentionally separate from {@link ActorMessageDeliveryState}: that
 * type describes inter-actor handoff projections (with semantic states like
 * `expired` / `skipped`), whereas this describes a single user message's
 * delivery through the durable at-least-once pipeline.
 */
export type MessageDeliveryStatus =
  | 'queued' // persisted, waiting to be claimed / deferred to a later turn
  | 'processing' // fed into the active SDK turn (submitted)
  | 'retrying' // non-terminal, re-driven after a stall (active job retry_count > 0)
  | 'delivered' // consumed by the SDK — terminal success
  | 'failed'; // terminal failure

/**
 * Active-job retry detail attached to a user message in the `retrying` state
 * (and, briefly, while a delivery-driven turn is being re-driven after a
 * recoverable provider error). `runAt` is the next attempt time (epoch ms); the
 * UI renders a countdown from `runAt - now` and "retry N/Max" from
 * `count`/`maxRetries` (`count` is the job's retry_count — completed failures —
 * so the label is "retry", not "attempt", which would read off-by-one). Omitted
 * when no delivery job is active.
 */
export interface MessageDeliveryRetryInfo {
  count: number;
  runAt?: number;
  maxRetries?: number;
}

/**
 * The raw `sdk_messages.send_status` column values. NULL (SDK / action rows)
 * is treated as `'consumed'` everywhere it is read.
 */
export type MessageSendStatus = 'deferred' | 'enqueued' | 'submitted' | 'consumed' | 'failed';

/**
 * Map a raw `send_status` (plus an optional active-job retry signal) to the
 * user-facing {@link MessageDeliveryStatus}.
 *
 * Returns `null` only for an unrecognised value; callers are expected to gate
 * the result on `message_type = 'user'` so non-user rows (assistant / system /
 * result, whose NULL `send_status` coalesces to `'consumed'`) do not get a
 * spurious `'delivered'` badge.
 *
 * Note that `'delivered'` (consumed) is mapped rather than hidden here: the UI
 * decides whether to render a badge for it (by default it does not, to avoid
 * noisy indicators on normal fast delivery — task #862 item 3).
 *
 * @param sendStatus Raw `sdk_messages.send_status` (NULL/undefined coalesces to `'consumed'`).
 * @param options.retrying True when an active `message_delivery` job for this
 *   message has `retry_count > 0` (the message is being re-driven after a stall).
 */
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
      // A consumed message is normally delivered. But when its delivery-driven
      // turn died on a recoverable provider error and is being re-driven, the
      // active job holds it for retry — surface `retrying` (with a countdown)
      // instead of a misleading "delivered".
      return retrying ? 'retrying' : 'delivered';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

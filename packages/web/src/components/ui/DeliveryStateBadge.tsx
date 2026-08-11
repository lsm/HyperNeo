import type { ActorMessageDeliveryState, MessageDeliveryStatus } from '@hyperneo/shared';
import { cn } from '../../lib/utils';

/**
 * Every delivery-state label the badge can render — the union of
 * {@link MessageDeliveryStatus} (user-message lifecycle, task #862) and
 * {@link ActorMessageDeliveryState} (inter-actor handoff projections). The two
 * domains overlap (queued / delivered / failed) but each contributes distinct
 * states; one canonical badge keeps the visual language consistent everywhere.
 */
export type DeliveryBadgeState = MessageDeliveryStatus | ActorMessageDeliveryState;

const DELIVERY_STATE_CLASSES: Record<DeliveryBadgeState, string> = {
  // MessageDeliveryStatus
  queued: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  processing: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
  // Retrying is more urgent than a plain queue — amber is reserved for queued,
  // so retrying reads as amber-on-orange to stand out.
  retrying: 'border-orange-500/50 bg-orange-500/15 text-orange-200',
  delivered: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  failed: 'border-red-500/45 bg-red-500/10 text-red-200',
  // ActorMessageDeliveryState (additional)
  expired: 'border-red-500/45 bg-red-500/10 text-red-200',
  skipped: 'border-gray-500/40 bg-gray-500/10 text-gray-300',
};

interface DeliveryStateBadgeProps {
  state?: DeliveryBadgeState | null;
  /** Override the label text (defaults to the state name). */
  label?: string;
  class?: string;
  'test-id'?: string;
}

export function DeliveryStateBadge({
  state,
  label,
  class: className = '',
  'test-id': testId = 'delivery-state-badge',
}: DeliveryStateBadgeProps) {
  if (!state) return null;
  return (
    <span
      class={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        DELIVERY_STATE_CLASSES[state],
        className
      )}
      data-testid={testId}
    >
      {label ?? state}
    </span>
  );
}

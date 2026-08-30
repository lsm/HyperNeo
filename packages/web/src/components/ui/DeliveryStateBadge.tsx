import type { ActorMessageDeliveryState, MessageDeliveryStatus } from '@hyperneo/shared';
import { cn } from '../../lib/utils';

export type DeliveryBadgeState = MessageDeliveryStatus | ActorMessageDeliveryState;

const DELIVERY_STATE_CLASSES: Record<DeliveryBadgeState, string> = {
  queued: 'border-warning/40 bg-warning/10 text-warning-soft',
  processing: 'border-sky-500/40 bg-sky-500/10 text-info-soft',
  retrying: 'border-orange-500/50 bg-warning/15 text-warning-soft',
  delivered: 'border-success/40 bg-success/10 text-success-soft',
  failed: 'border-danger/45 bg-danger/10 text-danger-soft',
  expired: 'border-danger/45 bg-danger/10 text-danger-soft',
  skipped: 'border-fg-faint/40 bg-fg-faint/10 text-fg-soft',
};

interface DeliveryStateBadgeProps {
  state?: DeliveryBadgeState | null;
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

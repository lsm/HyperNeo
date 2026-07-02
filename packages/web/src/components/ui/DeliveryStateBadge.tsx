import type { ActorMessageDeliveryState } from '@hyperneo/shared';
import { cn } from '../../lib/utils';

const DELIVERY_STATE_CLASSES: Record<ActorMessageDeliveryState, string> = {
  queued: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  delivered: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  failed: 'border-red-500/45 bg-red-500/10 text-red-200',
  expired: 'border-red-500/45 bg-red-500/10 text-red-200',
  skipped: 'border-gray-500/40 bg-gray-500/10 text-gray-300',
};

interface DeliveryStateBadgeProps {
  state?: ActorMessageDeliveryState | null;
  class?: string;
  'test-id'?: string;
}

export function DeliveryStateBadge({
  state,
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
      {state}
    </span>
  );
}

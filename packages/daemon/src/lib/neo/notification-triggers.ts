export const NEO_HUMAN_TRIGGER_PREFIX = 'human:';

export function neoHumanTrigger(messageId: string): string {
  return `${NEO_HUMAN_TRIGGER_PREFIX}${messageId}`;
}

export type NeoDeliveryTrigger = 'continues' | { readonly id: string } | null;

export function neoDeliveryTrigger(
  trigger: NeoDeliveryTrigger,
  parentTrigger: () => string | null
): string | null {
  if (trigger === 'continues') return parentTrigger();
  return trigger?.id ?? null;
}

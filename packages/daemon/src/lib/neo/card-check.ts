export const NEO_CARD_UNCHECKED_MS = 5 * 60_000;

export type NeoCardCheck = { checkedAt: number; unchecked: boolean };

export function planNeoCardCheck(
  prior: NeoCardCheck | undefined,
  read: boolean,
  now: number
): { next: NeoCardCheck; changed: boolean } {
  const checkedAt = read ? now : (prior?.checkedAt ?? now);
  const unchecked = now - checkedAt > NEO_CARD_UNCHECKED_MS;
  return { next: { checkedAt, unchecked }, changed: unchecked !== (prior?.unchecked ?? false) };
}

import { NEO_WAITING_REMINDER } from '@hyperneo/prompts';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';

type NeoWaitingAsk = NeoAsk & { remindedAt: number | null };

export function planNeoWaitingReminders(
  asks: readonly NeoWaitingAsk[],
  askedAt: number
): NeoWaitingAsk[] {
  return asks.filter((ask) => ask.updatedAt < askedAt && (ask.remindedAt ?? 0) < ask.updatedAt);
}

export function neoWaitingOnHuman(asks: readonly NeoAsk[]) {
  return asks.length
    ? {
        note: NEO_WAITING_REMINDER,
        asks: asks.map(({ id, title, status, outcome }) => ({
          id,
          title,
          status,
          question: outcome ?? title,
        })),
      }
    : undefined;
}

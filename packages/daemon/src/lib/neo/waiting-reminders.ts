import { NEO_WAITING_REMINDER } from '@hyperneo/prompts';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { nudgedMessageId } from './ask-origin.ts';

type NeoWaitingAsk = NeoAsk & { remindedAt: number | null };

export type NeoReminderListing = { updatedAt: number; turns: readonly string[] };
type NeoReminderListings = ReadonlyMap<string, NeoReminderListing>;

export const NEO_REMINDER_LISTINGS = 2;
const NEO_REMINDER_ASKS = 200;

export function neoReminderTurn(turn: { sessionId: string; messageId: string }): string {
  return `${turn.sessionId}:${nudgedMessageId(turn.messageId) ?? turn.messageId}`;
}

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

export function planNeoReminderListings(
  listings: NeoReminderListings,
  asks: readonly Pick<NeoAsk, 'id' | 'updatedAt'>[],
  turn: string
): { entries: [string, NeoReminderListing][]; evict: string[] } {
  const entries = asks.map((ask): [string, NeoReminderListing] => {
    const listed = listings.get(ask.id);
    const turns = listed?.updatedAt === ask.updatedAt ? listed.turns : [];
    return [
      ask.id,
      { updatedAt: ask.updatedAt, turns: turns.includes(turn) ? turns : [...turns, turn] },
    ];
  });
  const kept = [...listings.keys()].filter((id) => !asks.some((ask) => ask.id === id));
  return {
    entries,
    evict: kept.slice(0, Math.max(0, kept.length + entries.length - NEO_REMINDER_ASKS)),
  };
}

export function planNeoRemindersSpent(
  listings: NeoReminderListings,
  due: readonly Pick<NeoAsk, 'id' | 'updatedAt'>[],
  turn: string
): { spent: string[]; drop: string[] } {
  const listed = [...listings].filter(([, listing]) => listing.turns.includes(turn));
  const current = new Map(due.map((ask) => [ask.id, ask.updatedAt]));
  const spent = listed.flatMap(([id, listing]) =>
    current.get(id) === listing.updatedAt && listing.turns.length >= NEO_REMINDER_LISTINGS
      ? [id]
      : []
  );
  return {
    spent,
    drop: listed.flatMap(([id, listing]) =>
      spent.includes(id) || current.get(id) !== listing.updatedAt ? [id] : []
    ),
  };
}

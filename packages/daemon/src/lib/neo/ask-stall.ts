import { NEO_ASK_STALLED } from '@hyperneo/prompts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';

export const NEO_ASK_STALL_QUIET_MS = 60 * 60_000;

type NeoAskStallCard = Pick<NeoWork, 'id' | 'title' | 'status' | 'updatedAt'>;
type NeoAskStallSkip = 'not_open' | 'no_session' | 'no_cards' | 'running' | 'recent';

export function requireNeoAskStalled(
  ask: Pick<NeoAsk, 'status' | 'updatedAt'>,
  read: { cards: readonly NeoAskStallCard[]; session: boolean },
  now: number
): { value: string } | { reason: NeoAskStallSkip } {
  if (ask.status !== 'open') return { reason: 'not_open' };
  if (!read.session) return { reason: 'no_session' };
  if (!read.cards.length) return { reason: 'no_cards' };
  if (read.cards.some((card) => card.status !== 'failed' && card.status !== 'cancelled'))
    return { reason: 'running' };
  const last = Math.max(ask.updatedAt, ...read.cards.map((card) => card.updatedAt));
  if (now - last < NEO_ASK_STALL_QUIET_MS) return { reason: 'recent' };
  return { value: `stalled:${read.cards.map((card) => `${card.id}:${card.status}`).join(',')}` };
}

export function requireNeoAskStallUntold(told: boolean): { value: true } | { reason: 'told' } {
  return told ? { reason: 'told' } : { value: true };
}

export function neoAskStalledNote(
  ask: Pick<NeoAsk, 'id' | 'title'>,
  cards: readonly NeoAskStallCard[],
  replacedBy: string | null
): string {
  return `${NEO_ASK_STALLED}\n${JSON.stringify({
    askId: ask.id,
    title: ask.title,
    cards: cards.map(({ id, title, status }) => ({ id, title, status })),
    ...(replacedBy ? { replacedBy } : {}),
  })}`;
}

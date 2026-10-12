import { NEO_ASK_IDLE } from '@hyperneo/prompts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';

export const NEO_ASK_IDLE_MS = 20 * 60_000;

type NeoAskIdleCard = Pick<NeoWork, 'id' | 'title' | 'status'> & { progress: string };
type NeoAskIdleSkip = 'not_open' | 'no_session' | 'no_pending' | 'not_in_flight' | 'moving';
export type NeoAskIdleSeen = ReadonlyMap<string, { signature: string; since: number }>;

export function neoAskIdleSignature(
  ask: Pick<NeoAsk, 'doneItems'>,
  cards: readonly NeoAskIdleCard[]
): string {
  return [
    ...cards.map((card) => `${card.id}:${card.status}:${card.progress}`),
    ...(ask.doneItems ?? []).map((item) => `${item.id}:${item.state}:${item.removed ? 1 : 0}`),
  ].join(',');
}

export function trackNeoAskIdle(
  seen: NeoAskIdleSeen,
  live: readonly Pick<NeoAsk, 'id'>[],
  observed: ReadonlyMap<string, string>,
  now: number
): Map<string, { signature: string; since: number }> {
  return new Map(
    live.flatMap((ask) => {
      const signature = observed.get(ask.id);
      if (signature === undefined) return [];
      const prior = seen.get(ask.id);
      return [
        [ask.id, prior?.signature === signature ? prior : { signature, since: now }] as const,
      ];
    })
  );
}

export function requireNeoAskIdle(
  ask: Pick<NeoAsk, 'status' | 'doneItems'>,
  read: { cards: readonly NeoAskIdleCard[]; session: boolean; since: number; signature: string },
  now: number
): { value: string } | { reason: NeoAskIdleSkip } {
  if (ask.status !== 'open') return { reason: 'not_open' };
  if (!read.session) return { reason: 'no_session' };
  if (!(ask.doneItems ?? []).some((item) => !item.removed && item.state === 'pending'))
    return { reason: 'no_pending' };
  if (!read.cards.some((card) => card.status === 'queued' || card.status === 'reported'))
    return { reason: 'not_in_flight' };
  if (now - read.since < NEO_ASK_IDLE_MS) return { reason: 'moving' };
  return { value: `idle:${read.signature}` };
}

export function neoAskIdleNote(
  ask: Pick<NeoAsk, 'id' | 'title'>,
  cards: readonly NeoAskIdleCard[]
): string {
  return `${NEO_ASK_IDLE}\n${JSON.stringify({
    askId: ask.id,
    title: ask.title,
    cards: cards.map(({ id, title, status }) => ({ id, title, status })),
  })}`;
}

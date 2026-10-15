import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';

export function isNeoSummarized(item: object): boolean {
  return 'summarized' in item && item.summarized === true;
}

export function neoAskDetailKey(snapshot: NeoSnapshot | null, askId: string): string {
  const ask = snapshot?.asks?.find((item) => item.id === askId);
  const ids = new Set(ask?.workIds ?? []);
  const statuses = (snapshot?.work ?? [])
    .filter((item) => ids.has(item.id))
    .map((item) => `${item.id}=${item.status}`);
  return [askId, ask?.revision ?? '', ...statuses].join('\n');
}

export function mergeNeoAskDetails(
  snapshot: NeoSnapshot | null,
  details: ReadonlyMap<string, NeoSnapshot>
): NeoSnapshot | null {
  if (!snapshot || details.size === 0) return snapshot;
  const asks = new Map<string, NonNullable<NeoSnapshot['asks']>[number]>();
  const work = new Map<string, NeoSnapshot['work'][number]>();
  const cards = new Map<string, NeoSnapshot['cards'][number]>();
  for (const detail of details.values()) {
    for (const ask of detail.asks ?? []) asks.set(ask.id, ask);
    for (const item of detail.work) work.set(item.id, item);
    for (const card of detail.cards) cards.set(card.workId, card);
  }
  const fullWork = new Set<string>();
  return {
    ...snapshot,
    asks: snapshot.asks?.map((ask) => {
      const full = isNeoSummarized(ask) ? asks.get(ask.id) : undefined;
      return full && full.revision === ask.revision ? full : ask;
    }),
    work: snapshot.work.map((item) => {
      const full = isNeoSummarized(item) ? work.get(item.id) : undefined;
      if (!full || full.status !== item.status) return item;
      fullWork.add(item.id);
      return full;
    }),
    cards: snapshot.cards.map((card) =>
      fullWork.has(card.workId) ? (cards.get(card.workId) ?? card) : card
    ),
  };
}

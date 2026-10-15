import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';

export const isNeoAnswerItem = (item: Pick<NeoAskItem, 'outcomeKind'>) =>
  item.outcomeKind === 'answer';

export const isNeoAnswerReady = (
  item: Pick<NeoAskItem, 'outcomeKind' | 'state' | 'removed'>
): boolean => !item.removed && isNeoAnswerItem(item) && item.state === 'reported';

export function isNeoAskAnswerReady(ask: Pick<NeoAsk, 'doneItems'>): boolean {
  const items = (ask.doneItems ?? []).filter((item) => !item.removed);
  return (
    items.some(isNeoAnswerReady) &&
    items.every(
      (item) => item.state === 'met' || item.state === 'needs_you' || isNeoAnswerReady(item)
    )
  );
}

export function planNeoAnswerPublished(
  ask: NeoAsk,
  publicationId: string
): { ticks: { item: NeoAskItem; evidence: string }[]; settle: boolean } | null {
  if (ask.status === 'achieved' || ask.status === 'abandoned') return null;
  const items = (ask.doneItems ?? []).filter((item) => !item.removed);
  const ready = items.filter(isNeoAnswerReady);
  if (!ready.length) return null;
  const evidence = `Answered the human in publication ${publicationId}.`;
  return {
    ticks: ready.map((item) => ({ item, evidence })),
    settle: items.every((item) => item.state === 'met' || isNeoAnswerReady(item)),
  };
}

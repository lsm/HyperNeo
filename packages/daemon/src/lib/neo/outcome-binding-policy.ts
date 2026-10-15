import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { neoAskRevisionPolicy } from './ask-revision-policy.ts';

type Binding = { itemId: string; deliveredBy: string | null };
type Card = { id: string; dispatched: boolean; released?: boolean };
type Refusal = { ok: false; reason: string };

function fillIds(
  ask: Pick<NeoAsk, 'doneItems'>,
  bindings: readonly Binding[],
  cards: readonly Card[]
): Set<string> {
  const items = new Map((ask.doneItems ?? []).map((item) => [item.id, item]));
  const dispatched = new Set(cards.filter((card) => card.dispatched).map((card) => card.id));
  return new Set(
    bindings
      .filter((binding) => {
        const item = items.get(binding.itemId);
        return (
          !!item &&
          !item.deliveredBy &&
          item.state === 'pending' &&
          !!binding.deliveredBy &&
          !dispatched.has(binding.deliveredBy)
        );
      })
      .map((binding) => binding.itemId)
  );
}

function requireBindings(ask: NeoAsk | null, bindings: readonly Binding[], cards: readonly Card[]) {
  const reject = (reason: string): { reason: Refusal } => ({ reason: { ok: false, reason } });
  if (!ask || ['achieved', 'abandoned'].includes(ask.status)) return reject('ask_not_live');
  const items = new Map((ask.doneItems ?? []).map((item) => [item.id, item]));
  const local = new Map(cards.map((card) => [card.id, card]));
  const seen = new Set<string>();
  for (const binding of bindings) {
    const item = items.get(binding.itemId);
    if (!item || item.removed || item.decision || item.kind || seen.has(binding.itemId))
      return reject('invalid_outcome_binding');
    seen.add(binding.itemId);
    const next = binding.deliveredBy;
    if (next !== null && !local.has(next)) return reject('binding_card_not_owned');
    if ((item.deliveredBy ?? null) !== next) {
      const old = item.deliveredBy ? local.get(item.deliveredBy) : undefined;
      if ((old?.dispatched && !old.released) || (next && local.get(next)?.dispatched))
        return reject('binding_already_dispatched');
    }
  }
  const changes = new Map(bindings.map((binding) => [binding.itemId, binding.deliveredBy]));
  const bind = (item: NeoAskItem) =>
    changes.has(item.id) ? { ...item, deliveredBy: changes.get(item.id)! } : item;
  const fills = fillIds(ask, bindings, cards);
  const after = [...items.values()].map(bind);
  const revision = neoAskRevisionPolicy.planRevision(
    ask.revision ?? 0,
    {
      items: [...items.values()].map((item) => (fills.has(item.id) ? bind(item) : item)),
      cards: [],
    },
    { items: after, cards: [] }
  );
  return { value: { ask, bindings, ...revision } };
}

function planFold(
  source: NeoAsk,
  target: NeoAsk,
  moves: readonly { from: string; id: string; position: number }[]
): { items: NeoAskItem[]; revision: number } {
  const copied = new Set<string>();
  const ids = new Set((target.doneItems ?? []).map((item) => item.id));
  const items = moves.map((move) => {
    const item = source.doneItems?.find((entry) => entry.id === move.from && !entry.removed);
    if (!item || copied.has(move.from) || ids.has(move.id)) throw new Error('invalid_fold_items');
    if (item.deliveredBy && !source.workIds.includes(item.deliveredBy))
      throw new Error('binding_card_not_owned');
    copied.add(move.from);
    ids.add(move.id);
    const valid = neoAskRevisionPolicy.matchesVerifiedDefinition(
      item,
      item.verifiedDefinitionHash ?? null
    );
    return {
      ...item,
      id: move.id,
      ...(item.deliveredBy && !valid
        ? { state: 'pending' as const, evidence: null, metBy: null, verifiedDefinitionHash: null }
        : {}),
    };
  });
  if (source.doneItems?.some((item) => !item.removed && !copied.has(item.id)))
    throw new Error('invalid_fold_items');
  const revision = target.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER)
    throw new Error('invalid_ask_revision');
  return { items, revision: revision + 1 };
}

export const neoOutcomeBindingPolicy = { requireBindings, fillIds, planFold };

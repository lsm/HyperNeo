import { createHash } from 'node:crypto';

interface Definition {
  text: string;
  check: string | null;
  watch?: readonly string[];
}

interface Outcome extends Definition {
  id: string;
  deliveredBy?: string | null;
  removed?: boolean;
}

interface Plan {
  items: readonly Outcome[];
  cards: readonly { id: string; scope: string; dependsOn: readonly string[] }[];
}

const uniqueSorted = (values: readonly string[]) => [...new Set(values)].sort();
const definitionHash = (item: Definition) =>
  createHash('sha256')
    .update(JSON.stringify([item.text, item.check, uniqueSorted(item.watch ?? [])]))
    .digest('hex');

const outcomeSignature = (item: Outcome) =>
  JSON.stringify([definitionHash(item), item.deliveredBy ?? null, item.removed ?? false]);

const planSignature = (plan: Plan) =>
  JSON.stringify([
    plan.items.map((item) => [item.id, outcomeSignature(item)]).sort(),
    plan.cards.map((card) => [card.id, card.scope, uniqueSorted(card.dependsOn)]).sort(),
  ]);

function planRevision(revision: number, before: Plan, after: Plan) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER)
    throw new Error('invalid_ask_revision');
  const material = planSignature(before) !== planSignature(after);
  const previous = new Map(before.items.map((item) => [item.id, outcomeSignature(item)]));
  return {
    revision: revision + Number(material),
    invalidateApproval: material,
    invalidateItemIds: after.items
      .filter((item) => previous.get(item.id) !== outcomeSignature(item))
      .map((item) => item.id),
  };
}

export const neoAskRevisionPolicy = {
  definitionHash,
  planRevision,
  matchesVerifiedDefinition: (item: Definition, storedHash: string | null) =>
    storedHash !== null && storedHash === definitionHash(item),
};

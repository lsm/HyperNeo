import { neoAskRevisionPolicy } from './ask-revision-policy.ts';

type Edge = { workId: string; prerequisiteId: string };
type Card = {
  id: string;
  askId: string | null;
  revision: number;
  status: string;
  askStatus: string | null;
  startedAt: number | null;
  items: readonly { id: string; state: string; verified: boolean }[];
};
type Edit = { workId: string; dependsOn: readonly string[]; expectedRevision: number };
type Refusal = { ok: false; reason: string };

function requireEdit(
  input: Edit,
  cards: readonly Card[],
  edges: readonly Edge[],
  visible: ReadonlySet<string>
) {
  const reject = (reason: string): { reason: Refusal } => ({ reason: { ok: false, reason } });
  const byId = new Map(cards.map((card) => [card.id, card]));
  const card = byId.get(input.workId);
  const ids = [input.workId, ...input.dependsOn];
  if (ids.some((id) => !byId.has(id) || !visible.has(id))) return reject('dependency_not_visible');
  if (!card?.askId || ['achieved', 'abandoned'].includes(card.askStatus ?? ''))
    return reject('dependency_ask_not_live');
  if (card.status === 'cancelled') return reject('dependent_cancelled');
  if (card.revision !== input.expectedRevision) return reject('stale_ask_revision');
  if (new Set(input.dependsOn).size !== input.dependsOn.length)
    return reject('duplicate_dependency');
  if (input.dependsOn.includes(input.workId)) return reject('self_dependency');
  if (input.dependsOn.length && ids.some((id) => !byId.get(id)!.items.length))
    return reject('dependency_outcomes_missing');
  const prior = edges
    .filter((edge) => edge.workId === input.workId)
    .map((edge) => edge.prerequisiteId);
  const revision = neoAskRevisionPolicy.planRevision(
    card.revision,
    { items: [], cards: [{ id: card.id, scope: '', dependsOn: prior }] },
    { items: [], cards: [{ id: card.id, scope: '', dependsOn: input.dependsOn }] }
  );
  if (revision.invalidateApproval && (card.status !== 'proposed' || card.startedAt !== null))
    return reject('dependency_already_dispatched');
  const next = edges.filter((edge) => edge.workId !== input.workId);
  const adjacency = new Map<string, string[]>();
  for (const edge of next)
    adjacency.set(edge.workId, [...(adjacency.get(edge.workId) ?? []), edge.prerequisiteId]);
  const queue = [...input.dependsOn];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.pop()!;
    if (id === input.workId) return reject('dependency_cycle');
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(adjacency.get(id) ?? []));
  }
  return { value: { askId: card.askId, dependsOn: [...input.dependsOn].sort(), ...revision } };
}

function blockers(workId: string, cards: readonly Card[], edges: readonly Edge[]) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const card = byId.get(workId);
  const blocked: { workId: string; reason: string; itemIds: string[] }[] = [];
  if (!card || card.status === 'cancelled' || card.askStatus === 'abandoned')
    return [{ workId, reason: 'dependent_unavailable', itemIds: [] }];
  for (const edge of edges.filter((edge) => edge.workId === workId)) {
    const prerequisite = byId.get(edge.prerequisiteId);
    const reason = !prerequisite
      ? 'prerequisite_missing'
      : prerequisite.status === 'cancelled' || prerequisite.askStatus === 'abandoned'
        ? 'prerequisite_cancelled'
        : !prerequisite.items.length
          ? 'dependency_outcomes_missing'
          : null;
    const unmet =
      prerequisite?.items.filter((item) => item.state !== 'met' || !item.verified) ?? [];
    if (reason || unmet.length)
      blocked.push({
        workId: edge.prerequisiteId,
        reason: reason ?? 'outcomes_unverified',
        itemIds: unmet.map((item) => item.id),
      });
  }
  return blocked;
}

export const neoDependencyGraphPolicy = { requireEdit, blockers };

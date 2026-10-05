import type { Place, PlaceGroup, WorkSummary } from './types.ts';

export function placeKey(place: Place): string {
  const where = place.folder ?? (place.spaceId ? `space:${place.spaceId}` : `chats`);
  return `${place.machine}\u0000${where}`;
}

function mergePair(into: PlaceGroup, next: PlaceGroup): PlaceGroup {
  return {
    place: into.place,
    lastActivityAt: Math.max(into.lastActivityAt, next.lastActivityAt),
    openCount: into.openCount + next.openCount,
    archivedCount: into.archivedCount + next.archivedCount,
    adapters: [...new Set([...into.adapters, ...next.adapters])].sort(),
    work: [...into.work, ...next.work],
  };
}

export function mergePlaceGroups(groups: readonly PlaceGroup[], limit: number): PlaceGroup[] {
  const byPlace = new Map<string, PlaceGroup>();
  for (const group of groups) {
    const key = placeKey(group.place);
    const existing = byPlace.get(key);
    byPlace.set(key, existing ? mergePair(existing, group) : group);
  }
  return [...byPlace.values()]
    .map((group) => ({
      ...group,
      work: [...group.work].sort((a, b) => b.lastActivityAt - a.lastActivityAt),
    }))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, limit);
}

export function stampDaemon(groups: readonly PlaceGroup[], daemon: string): PlaceGroup[] {
  return groups.map((group) => ({
    ...group,
    place: { ...group.place, daemon },
    work: group.work.map((work) => stampWork(work, daemon)),
  }));
}

export function stampWork<Work extends WorkSummary>(work: Work, daemon: string): Work {
  return { ...work, ref: { ...work.ref, daemon }, place: { ...work.place, daemon } };
}

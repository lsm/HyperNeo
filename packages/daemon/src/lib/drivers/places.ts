import type { WorkChatMatch } from '../../storage/work-chat-search.ts';
import type { Place, PlaceGroup, WorkSummary } from './types.ts';

export function placeKey(place: Place): string {
  const where = place.folder ?? (place.spaceId ? `space:${place.spaceId}` : `chats`);
  return `${place.daemon ?? place.machine}\u0000${where}`;
}

function mergePair(into: PlaceGroup, next: PlaceGroup): PlaceGroup {
  return {
    place: into.place,
    workspaces: [...(into.workspaces ?? [into.place]), ...(next.workspaces ?? [next.place])],
    lastActivityAt: Math.max(into.lastActivityAt, next.lastActivityAt),
    openCount: into.openCount + next.openCount,
    archivedCount: into.archivedCount + next.archivedCount,
    adapters: [...new Set([...into.adapters, ...next.adapters])].sort(),
    work: [...into.work, ...next.work],
  };
}

function bestScore(group: PlaceGroup): number {
  return Math.max(-1, ...group.work.map((work) => work.score ?? -1));
}

export function mergePlaceGroups(groups: readonly PlaceGroup[], limit: number): PlaceGroup[] {
  const byPlace = new Map<string, PlaceGroup>();
  const aliases = new Map<string, string>();
  for (const group of groups) {
    const keys = (group.workspaces ?? [group.place]).flatMap((place) => [
      `folder:${placeKey(place)}`,
      ...(place.codeIdentity ? [place.codeIdentity] : []),
      ...(place.toolProject
        ? [`tool:${place.daemon ?? place.machine}:${place.toolProject.id}`]
        : []),
    ]);
    const matches = new Set(keys.flatMap((key) => aliases.get(key) ?? []));
    const key = [...matches][0] ?? keys[0];
    let merged = group;
    for (const match of matches) {
      const existing = byPlace.get(match);
      if (existing) merged = mergePair(existing, merged);
      byPlace.delete(match);
    }
    for (const [alias, target] of aliases) if (matches.has(target)) aliases.set(alias, key);
    for (const alias of keys) aliases.set(alias, key);
    byPlace.set(key, merged);
  }
  return [...byPlace.values()]
    .map((group) => ({
      ...group,
      projectId:
        (group.workspaces ?? [group.place])
          .flatMap((place) => place.codeIdentity ?? [])
          .sort()[0] ??
        (group.workspaces ?? [group.place])
          .flatMap((place) =>
            place.toolProject ? `tool:${place.daemon ?? place.machine}:${place.toolProject.id}` : []
          )
          .sort()[0] ??
        `folder:${placeKey(group.place)}`,
      workspaces: [
        ...new Map(
          (group.workspaces ?? [group.place]).map((place) => [
            `${placeKey(place)}:${place.toolProject?.id ?? ''}`,
            place,
          ])
        ).values(),
      ],
      work: [...group.work].sort(
        (a, b) => (b.score ?? -1) - (a.score ?? -1) || b.lastActivityAt - a.lastActivityAt
      ),
    }))
    .sort((a, b) => bestScore(b) - bestScore(a) || b.lastActivityAt - a.lastActivityAt)
    .slice(0, limit);
}

export function stampDaemon(groups: readonly PlaceGroup[], daemon: string): PlaceGroup[] {
  return groups.map((group) => ({
    ...group,
    place: { ...group.place, daemon },
    ...(group.workspaces
      ? { workspaces: group.workspaces.map((place) => ({ ...place, daemon })) }
      : {}),
    work: group.work.map((work) => stampWork(work, daemon)),
  }));
}

export function stampWork<Work extends WorkSummary>(work: Work, daemon: string): Work {
  return { ...work, ref: { ...work.ref, daemon }, place: { ...work.place, daemon } };
}

export function withChatEvidence(work: WorkSummary, chat: WorkChatMatch | undefined): WorkSummary {
  if (!chat) return work;
  return {
    ...work,
    score: chat.score,
    hits: chat.hits,
    lastHitAt: chat.lastHitAt,
    snippets: chat.snippets.map((snippet) => ({
      match: snippet.match,
      at: snippet.at,
      role: snippet.role,
      text: snippet.text,
      ...(snippet.sessionId
        ? { handle: { sessionId: snippet.sessionId, messageId: snippet.messageId } }
        : {}),
    })),
  };
}

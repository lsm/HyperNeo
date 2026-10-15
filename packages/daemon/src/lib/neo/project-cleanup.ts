const NEO_PROJECT_ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export type NeoProjectFacts = {
  id: string;
  title: string;
  createdAt: number;
  lastActivity: number;
  section: boolean;
  context: number;
  asks: number;
  liveAsks: number;
  work: number;
  liveWork: number;
  routed: number;
  workspaces: readonly string[];
};

export type NeoProjectCleanup =
  | { action: 'delete'; projectId: string; title: string }
  | { action: 'merge'; projectId: string; title: string; targetId: string }
  | { action: 'archive'; projectId: string; title: string };

const isEmpty = (project: NeoProjectFacts) =>
  !project.section && project.asks + project.work + project.routed + project.context === 0;

const isLive = (project: NeoProjectFacts) => project.liveAsks + project.liveWork > 0;

const sameKey = (title: string) => title.trim().toLowerCase();

function olderSibling(
  project: NeoProjectFacts,
  kept: readonly NeoProjectFacts[]
): NeoProjectFacts | null {
  return (
    kept.find(
      (other) =>
        other.createdAt < project.createdAt &&
        (sameKey(other.title) === sameKey(project.title) ||
          other.workspaces.some((alias) => project.workspaces.includes(alias)))
    ) ?? null
  );
}

export function planNeoProjectCleanup(
  projects: readonly NeoProjectFacts[],
  now: number,
  pinned: ReadonlySet<string>
): NeoProjectCleanup[] {
  const candidates = projects.filter((project) => !pinned.has(project.id) && !project.section);
  const kept = [...candidates]
    .filter((project) => !isEmpty(project))
    .sort((a, b) => a.createdAt - b.createdAt);
  return candidates.flatMap((project): NeoProjectCleanup[] => {
    const named = { projectId: project.id, title: project.title };
    if (isEmpty(project)) return [{ action: 'delete', ...named }];
    if (isLive(project)) return [];
    const target = olderSibling(project, kept);
    if (target) return [{ action: 'merge', ...named, targetId: target.id }];
    return now - project.lastActivity > NEO_PROJECT_ARCHIVE_AFTER_MS
      ? [{ action: 'archive', ...named }]
      : [];
  });
}

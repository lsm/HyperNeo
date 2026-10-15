export type NeoProjectFacts = {
  id: string;
  title: string;
  createdAt: number;
  section: boolean;
  context: number;
  asks: number;
  liveAsks: number;
  work: { lastActivityAt: number }[];
  liveWork: number;
  routed: number;
  holderMessages: number;
  aliases: readonly string[];
};

export type NeoProjectCleanup =
  | { action: 'delete'; projectId: string; title: string }
  | { action: 'merge'; projectId: string; title: string; targetId: string }
  | { action: 'archive'; projectId: string; title: string };

const DAY_MS = 24 * 60 * 60 * 1000;

function isNeoOngoingPlace(work: readonly { lastActivityAt: number }[]): boolean {
  return new Set(work.map((item) => Math.floor(item.lastActivityAt / DAY_MS))).size > 1;
}

const repositories = (project: NeoProjectFacts) =>
  project.aliases.filter((alias) => alias.startsWith('repository:'));

const isEmpty = (project: NeoProjectFacts) =>
  project.asks + project.work.length + project.routed + project.context + project.holderMessages ===
  0;

const isLive = (project: NeoProjectFacts) => project.liveAsks + project.liveWork > 0;

const isOngoing = (project: NeoProjectFacts) =>
  project.routed > 0 || isNeoOngoingPlace(project.work);

const isElsewhere = (project: NeoProjectFacts, machine: string) => {
  const folders = project.aliases.filter((alias) => alias.startsWith('folder:'));
  return folders.length > 0 && !folders.some((alias) => alias.startsWith(`folder:${machine}`));
};

const sameKey = (title: string) => title.trim().toLowerCase();

function belongsTo(project: NeoProjectFacts, other: NeoProjectFacts): boolean {
  const own = repositories(project);
  if (own.length) return repositories(other).some((alias) => own.includes(alias));
  return (
    sameKey(other.title) === sameKey(project.title) ||
    other.aliases.some((alias) => alias.startsWith('folder:') && project.aliases.includes(alias))
  );
}

export function planNeoProjectCleanup(
  projects: readonly NeoProjectFacts[],
  scope: { pinned: ReadonlySet<string>; machine: string }
): NeoProjectCleanup[] {
  const homes = projects
    .filter((project) => repositories(project).length)
    .sort((a, b) => a.createdAt - b.createdAt);
  return projects
    .filter((project) => !scope.pinned.has(project.id) && !project.section)
    .flatMap((project): NeoProjectCleanup[] => {
      const named = { projectId: project.id, title: project.title };
      const repository = repositories(project).length > 0;
      if (!repository && (isElsewhere(project, scope.machine) || isLive(project))) return [];
      if (!repository && isEmpty(project)) return [{ action: 'delete', ...named }];
      const home = homes.find(
        (other) =>
          other.id !== project.id &&
          (!repository || other.createdAt < project.createdAt) &&
          belongsTo(project, other)
      );
      if (home) return [{ action: 'merge', ...named, targetId: home.id }];
      return repository || isOngoing(project) ? [] : [{ action: 'archive', ...named }];
    });
}

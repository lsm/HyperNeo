export type NeoProjectFacts = {
  id: string;
  title: string;
  createdAt: number;
  section: boolean;
  context: number;
  asks: number;
  liveAsks: number;
  work: { lastActivityAt: number; ref: string | null }[];
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

const cards = (project: NeoProjectFacts, other: NeoProjectFacts) =>
  project.work.filter(
    (item) =>
      item.ref &&
      other.aliases.some(
        (alias) => alias.startsWith('work:') && alias.endsWith(`\u0000${item.ref}`)
      )
  ).length;

function belongsTo(project: NeoProjectFacts, other: NeoProjectFacts): boolean {
  const own = repositories(project);
  if (own.length) return repositories(other).some((alias) => own.includes(alias));
  return (
    sameKey(other.title) === sameKey(project.title) ||
    other.aliases.some((alias) => alias.startsWith('folder:') && project.aliases.includes(alias))
  );
}

function home(
  project: NeoProjectFacts,
  homes: readonly NeoProjectFacts[]
): NeoProjectFacts | undefined {
  const others = homes.filter((other) => other.id !== project.id);
  if (repositories(project).length)
    return others.find((other) => other.createdAt < project.createdAt && belongsTo(project, other));
  const byCards = others
    .map((other) => ({ other, count: cards(project, other) }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count)[0]?.other;
  return byCards ?? others.find((other) => belongsTo(project, other));
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
      const target = home(project, homes);
      if (target) return [{ action: 'merge', ...named, targetId: target.id }];
      return repository || isOngoing(project) ? [] : [{ action: 'archive', ...named }];
    });
}

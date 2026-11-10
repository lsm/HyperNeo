export type NeoProjectFacts = {
  id: string;
  title: string;
  createdAt: number;
  section: boolean;
  context: number;
  asks: number;
  liveAsks: number;
  aliases: readonly string[];
  protected?: boolean;
  home?: boolean;
};

export type NeoProjectCleanup =
  | { action: 'delete'; projectId: string; title: string }
  | { action: 'merge'; projectId: string; title: string; targetId: string };

const isEmpty = (project: NeoProjectFacts) => project.asks + project.context === 0;

const isLive = (project: NeoProjectFacts) => project.liveAsks > 0;

export function neoCleanupFolders(projects: readonly NeoProjectFacts[], machine: string): string[] {
  const local = `folder:${machine}\u0000`;
  return projects
    .filter((project) => !project.protected && isEmpty(project))
    .flatMap((project) => project.aliases.filter((alias) => alias.startsWith(local)))
    .map((alias) => alias.slice(local.length));
}

const isElsewhere = (project: NeoProjectFacts, machine: string) => {
  const folders = project.aliases.filter((alias) => alias.startsWith('folder:'));
  return (
    folders.length > 0 && !folders.some((alias) => alias.startsWith(`folder:${machine}\u0000`))
  );
};

const sameKey = (title: string) => title.trim().toLowerCase();

const home = (project: NeoProjectFacts, homes: readonly NeoProjectFacts[]) =>
  homes.find((other) => sameKey(other.title) === sameKey(project.title));

export function planNeoProjectCleanup(
  projects: readonly NeoProjectFacts[],
  scope: { pinned: ReadonlySet<string>; machine: string; mirrored: ReadonlySet<string> }
): NeoProjectCleanup[] {
  const homes = projects
    .filter((project) => project.home && !isElsewhere(project, scope.machine))
    .sort((a, b) => a.createdAt - b.createdAt);
  const decide = (project: NeoProjectFacts): NeoProjectCleanup[] => {
    const named = { projectId: project.id, title: project.title };
    if (project.home) return [];
    if (isEmpty(project))
      return project.protected || project.aliases.some((alias) => scope.mirrored.has(alias))
        ? []
        : [{ action: 'delete', ...named }];
    if (isElsewhere(project, scope.machine)) return [];
    const target = home(project, homes);
    return target ? [{ action: 'merge', ...named, targetId: target.id }] : [];
  };
  return projects
    .filter((project) => !scope.pinned.has(project.id) && !project.section)
    .flatMap((project) => (isLive(project) ? [] : decide(project)));
}

export const isNeoUnattendedCleanup = (step: NeoProjectCleanup) => step.action !== 'merge';

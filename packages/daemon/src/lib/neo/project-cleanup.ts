import type { Place, PlaceGroup } from '../drivers/types.ts';
import { canNeoMirrorCreateProject, planNeoWorkspaceProjects } from './project-mirror.ts';

export type NeoProjectFacts = {
  id: string;
  title: string;
  createdAt: number;
  section: boolean;
  context: number;
  asks: number;
  liveAsks: number;
  work: { ref: string | null }[];
  liveWork: number;
  routed: number;
  holderMessages: number;
  archived: boolean;
  aliases: readonly string[];
};

export type NeoProjectCleanup =
  | { action: 'delete'; projectId: string; title: string }
  | { action: 'merge'; projectId: string; title: string; targetId: string }
  | { action: 'archive'; projectId: string; title: string };

const repositories = (project: NeoProjectFacts) =>
  project.aliases.filter((alias) => alias.startsWith('repository:'));

const isEmpty = (project: NeoProjectFacts) =>
  project.asks + project.work.length + project.routed + project.context + project.holderMessages ===
  0;

export function neoMirroredAliases(
  places: readonly PlaceGroup[],
  plumbing: (place: Place) => boolean
): Set<string> {
  return new Set(
    planNeoWorkspaceProjects(places, plumbing)
      .filter(canNeoMirrorCreateProject)
      .flatMap((project) => project.aliases)
  );
}

const isLive = (project: NeoProjectFacts) => project.liveAsks + project.liveWork > 0;

export function neoCleanupFolders(projects: readonly NeoProjectFacts[], machine: string): string[] {
  const local = `folder:${machine}\u0000`;
  return projects
    .filter((project) => !repositories(project).length && isEmpty(project))
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

const cards = (project: NeoProjectFacts, other: NeoProjectFacts) =>
  project.work.filter(
    (item) =>
      item.ref &&
      other.aliases.some(
        (alias) => alias.startsWith('work:') && alias.endsWith(`\u0000${item.ref}`)
      )
  ).length;

function home(
  project: NeoProjectFacts,
  homes: readonly NeoProjectFacts[]
): NeoProjectFacts | undefined {
  const byCards = homes
    .map((other) => ({ other, count: cards(project, other) }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count)[0]?.other;
  return byCards ?? homes.find((other) => sameKey(other.title) === sameKey(project.title));
}

export function planNeoProjectCleanup(
  projects: readonly NeoProjectFacts[],
  scope: {
    pinned: ReadonlySet<string>;
    machine: string;
    mirrored: ReadonlySet<string>;
    archive?: ReadonlySet<string>;
  }
): NeoProjectCleanup[] {
  const homes = projects
    .filter(
      (project) =>
        repositories(project).length && !project.archived && !isElsewhere(project, scope.machine)
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  return projects
    .filter((project) => !scope.pinned.has(project.id) && !project.section && !project.archived)
    .flatMap((project): NeoProjectCleanup[] => {
      const named = { projectId: project.id, title: project.title };
      if (isLive(project)) return [];
      if (scope.archive?.has(project.id)) return [{ action: 'archive', ...named }];
      if (repositories(project).length || isElsewhere(project, scope.machine)) return [];
      if (isEmpty(project))
        return project.aliases.some((alias) => scope.mirrored.has(alias))
          ? []
          : [{ action: 'delete', ...named }];
      const target = home(project, homes);
      return target ? [{ action: 'merge', ...named, targetId: target.id }] : [];
    });
}

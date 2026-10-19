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
  aliases: readonly string[];
};

export type NeoProjectCleanup =
  | { action: 'delete'; projectId: string; title: string }
  | { action: 'merge'; projectId: string; title: string; targetId: string };

const repositories = (project: NeoProjectFacts) =>
  project.aliases.filter((alias) => alias.startsWith('repository:'));

const hasRepo = (project: NeoProjectFacts) =>
  project.aliases.some((alias) => alias.startsWith('repository:') || alias.startsWith('repo:'));

const isEmpty = (project: NeoProjectFacts) =>
  project.asks + project.work.length + project.context === 0;

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
    .filter((project) => !hasRepo(project) && isEmpty(project))
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
  scope: { pinned: ReadonlySet<string>; machine: string; mirrored: ReadonlySet<string> }
): NeoProjectCleanup[] {
  const homes = projects
    .filter((project) => repositories(project).length && !isElsewhere(project, scope.machine))
    .sort((a, b) => a.createdAt - b.createdAt);
  const decide = (project: NeoProjectFacts): NeoProjectCleanup[] => {
    const named = { projectId: project.id, title: project.title };
    if (repositories(project).length) return [];
    if (isEmpty(project))
      return hasRepo(project) || project.aliases.some((alias) => scope.mirrored.has(alias))
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

import type { Place, PlaceGroup } from '../../../drivers/types.ts';
import type { NeoProjectFacts } from '../../project-cleanup.ts';
import type { NeoProjectIdentityPolicy } from '../../project-mirror.ts';
import {
  backfillNeoRepositoryIdentities,
  canNeoMirrorCreateProject,
  planNeoWorkspaceProjects,
} from './project-mirror.ts';

const repositories = (project: NeoProjectFacts) =>
  project.aliases.filter((alias) => alias.startsWith('repository:'));

const hasRepo = (project: NeoProjectFacts) =>
  project.aliases.some((alias) => alias.startsWith('repository:') || alias.startsWith('repo:'));

export const codingProjectFacts = (projects: readonly NeoProjectFacts[]): NeoProjectFacts[] =>
  projects.map((project) => ({
    ...project,
    protected: hasRepo(project),
    home: repositories(project).length > 0,
  }));

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

export const codingProjectIdentity: NeoProjectIdentityPolicy = {
  backfill: backfillNeoRepositoryIdentities,
  facts: codingProjectFacts,
  mirroredAliases: neoMirroredAliases,
};

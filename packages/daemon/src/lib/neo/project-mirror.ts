import { neoRepoAlias } from './project-route-facts.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { isTempCwd } from '../drivers/claude-feed.ts';
import { sep } from 'node:path';
import type { Place, PlaceGroup } from '../drivers/types.ts';
import { placeKey } from '../drivers/places.ts';
import { neoFolderPath } from './folder.ts';
import { repoNameFromRemote } from '../drivers/code-identity.ts';
import { mergeNeoDuplicateProjects, type NeoProjectMergeInput } from './project-merge.ts';

export interface NeoWorkspaceProject {
  aliases: string[];
  title: string;
}

export function isNeoPlumbingFolder(
  place: Pick<Place, 'folder' | 'machine' | 'daemon'>,
  local: {
    machine: string;
    neoFolder: string;
    isTemp(path: string): boolean;
    exists(path: string): boolean;
  }
): boolean {
  const folder = place.folder;
  if (!folder) return false;
  const here = !place.daemon && place.machine === local.machine;
  return (
    folder === local.neoFolder ||
    folder.startsWith(`${local.neoFolder}${sep}`) ||
    /[/\\]Neo[/\\]\.coordinators([/\\]|$)/.test(folder) ||
    local.isTemp(folder) ||
    (here && !local.exists(folder))
  );
}

const GENERATED_FOLDER = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$|^[0-9a-f]{8}$|^worktrees$/i;

export function neoWorkspaceTitle(workspaces: readonly Place[], primary: Place): string {
  const repo = workspaces.flatMap(
    (place) => place.repoName ?? repoNameFromRemote(place.remotes?.[0]) ?? []
  )[0];
  if (repo) return repo;
  const tool = workspaces.find((place) => place.toolProject)?.toolProject?.name;
  if (tool) return tool;
  const readable = (primary.folder ?? '')
    .split(/[/\\]/)
    .filter(Boolean)
    .reverse()
    .find((segment) => !GENERATED_FOLDER.test(segment));
  return GENERATED_FOLDER.test(primary.name) && readable ? readable : primary.name;
}

export function isNeoMirrorTitled(project: { title: string; summary: string }): boolean {
  const lines = project.summary.split('\n\n');
  return (
    lines.includes(`Project: ${project.title}`) &&
    lines.every((line) => line.startsWith('Project: '))
  );
}

export function planNeoWorkspaceProjects(
  groups: readonly PlaceGroup[],
  plumbing: (place: Place) => boolean = () => false
): NeoWorkspaceProject[] {
  return groups
    .filter((group) => group.place.folder || group.place.toolProject)
    .flatMap((group) => {
      const workspaces = (group.workspaces ?? [group.place]).filter((place) => !plumbing(place));
      if (!workspaces.length) return [];
      const primary = plumbing(group.place) ? workspaces[0] : group.place;
      return {
        aliases: [
          ...new Set([
            ...(group.projectId ? [group.projectId] : []),
            ...group.work.map(
              (work) =>
                `work:${work.ref.daemon ?? work.place.daemon ?? work.place.machine}\u0000${work.ref.adapter}\u0000${work.ref.id}`
            ),
            ...workspaces.flatMap((place) => [
              `folder:${placeKey(place)}`,
              ...(place.remotes ?? []).flatMap((remote) => {
                const alias = neoRepoAlias(remote);
                return alias ? [`${alias}${group.projectId ?? placeKey(place)}`] : [];
              }),
              ...(place.codeIdentity ? [place.codeIdentity] : []),
              ...(place.toolProject
                ? [`tool:${place.daemon ?? place.machine}:${place.toolProject.id}`]
                : []),
            ]),
          ]),
        ],
        title: neoWorkspaceTitle(workspaces, primary),
      };
    });
}

export function planNeoMirrorMerges(
  projects: readonly NeoWorkspaceProject[],
  owner: (alias: string) => string | null,
  revision: (projectId: string) => number | null
): NeoProjectMergeInput[] {
  return projects.flatMap((project) => {
    const identities = project.aliases.filter((alias) => alias.startsWith('git:'));
    if (!identities.length) return [];
    const [target, ...sources] = [
      ...new Set([...identities, ...project.aliases].flatMap((alias) => owner(alias) ?? [])),
    ];
    const targetRevision = target ? revision(target) : null;
    if (!target || targetRevision === null) return [];
    return sources.flatMap((sourceId) => {
      const sourceRevision = revision(sourceId);
      return sourceRevision === null
        ? []
        : [
            {
              sourceId,
              targetId: target,
              sourceRevision,
              targetRevision,
              sourceIdentities: identities,
              targetIdentities: identities,
            },
          ];
    });
  });
}

export function mergeNeoMirroredDuplicates(
  db: Database,
  projects: readonly NeoWorkspaceProject[]
): boolean {
  const repo = new NeoRepository(db);
  const owner = (alias: string) =>
    (
      db.prepare('SELECT project_id FROM neo_project_workspaces WHERE alias = ?').get(alias) as {
        project_id: string;
      } | null
    )?.project_id ?? null;
  return (
    mergeNeoDuplicateProjects(
      () => planNeoMirrorMerges(projects, owner, (id) => repo.getProject(id)?.revision ?? null),
      (input) => repo.projectMerges.merge(input),
      () => {}
    ).length > 0
  );
}

export function persistNeoWorkspaceProjects(
  db: Database,
  projects: readonly NeoWorkspaceProject[]
): boolean {
  const repo = new NeoRepository(db);
  return db.transaction(() => {
    let changed = false;
    for (const project of projects) {
      const identities = project.aliases.filter(
        (alias) =>
          !alias.startsWith('folder:') && !alias.startsWith('repo:') && !alias.startsWith('work:')
      );
      const known = (identities.length ? identities : project.aliases).flatMap((alias) => {
        const row = db
          .prepare('SELECT project_id FROM neo_project_workspaces WHERE alias = ?')
          .get(alias) as { project_id: string } | null;
        return row ? [row.project_id] : [];
      });
      const id = known[0] ?? `project:${crypto.randomUUID()}`;
      const existing = known.length ? repo.getProject(id) : null;
      if (!known.length) {
        changed = true;
        repo.saveProject(
          { id, title: project.title, summary: `Project: ${project.title}`, context: '' },
          0
        );
      } else if (existing && existing.title !== project.title && isNeoMirrorTitled(existing)) {
        changed = true;
        repo.saveProject(
          { ...existing, title: project.title, summary: `Project: ${project.title}` },
          existing.revision
        );
      }
      for (const alias of project.aliases)
        db.prepare(
          `INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)
          ON CONFLICT(alias) DO UPDATE SET project_id = excluded.project_id
          WHERE excluded.alias LIKE 'folder:%' OR excluded.alias LIKE 'work:%'`
        ).run(alias, id);
    }
    return changed;
  })();
}

export const mirrorNeoWorkspaceProjects = (superpipe({})('neo-project-mirror') as PipelineAPI)
  .input(['db', 'groups'])
  .pipe(
    (groups: readonly PlaceGroup[]) => {
      const local = {
        machine: hostname(),
        neoFolder: neoFolderPath(),
        isTemp: isTempCwd,
        exists: existsSync,
      };
      return planNeoWorkspaceProjects(groups, (place) => isNeoPlumbingFolder(place, local));
    },
    'groups',
    'projects'
  )
  .pipe(
    (db: Database, projects: readonly NeoWorkspaceProject[]) => {
      const merged = mergeNeoMirroredDuplicates(db, projects);
      return persistNeoWorkspaceProjects(db, projects) || merged;
    },
    ['db', 'projects'],
    'changed'
  )
  .end('changed') as (db: Database, groups: readonly PlaceGroup[]) => boolean;

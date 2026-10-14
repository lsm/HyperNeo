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
  if (!folder || place.daemon || place.machine !== local.machine) return false;
  return (
    folder === local.neoFolder ||
    folder.startsWith(`${local.neoFolder}${sep}`) ||
    local.isTemp(folder) ||
    !local.exists(folder)
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
        title: workspaces.find((place) => place.toolProject)?.toolProject?.name ?? primary.name,
      };
    });
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
      if (!known.length) {
        changed = true;
        repo.saveProject(
          { id, title: project.title, summary: `Project: ${project.title}`, context: '' },
          0
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
  .pipe(persistNeoWorkspaceProjects, ['db', 'projects'], 'changed')
  .end('changed') as (db: Database, groups: readonly PlaceGroup[]) => boolean;

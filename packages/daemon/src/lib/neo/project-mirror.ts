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
import { runLagPhase } from '../event-loop-activity.ts';

export function neoIdentityOwner(
  held: string | null,
  carriers: readonly string[],
  tool: (projectId: string) => boolean
): string | null {
  const standalone = [held ?? [], ...carriers].flat().find((id) => !tool(id));
  return standalone ?? held ?? carriers[0] ?? null;
}

function neoToolProjects(db: Database): (projectId: string) => boolean {
  const ids = new Set(
    (
      db
        .prepare("SELECT DISTINCT project_id FROM neo_project_workspaces WHERE alias LIKE 'tool:%'")
        .all() as { project_id: string }[]
    ).map((row) => row.project_id)
  );
  return (projectId) => ids.has(projectId);
}

export interface NeoWorkspaceProject {
  aliases: string[];
  title: string;
}

export function neoProjectFolders(
  aliases: readonly string[]
): { machine: string; folder: string }[] {
  return aliases.flatMap((alias) => {
    const at = alias.indexOf('\u0000');
    return alias.startsWith('folder:') && at > 0
      ? [{ machine: alias.slice('folder:'.length, at), folder: alias.slice(at + 1) }]
      : [];
  });
}

export function neoRepositoryIdentity(remote: string | undefined): string | null {
  const path = remote
    ?.trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?/i, '')
    .replace(/^[^@/:]+@([^:/]+):/, '$1/')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
  return path && /^[^/\s]+\/[^\s]+$/.test(path) ? `repository:${path}` : null;
}

export function canNeoMirrorCreateProject(project: Pick<NeoWorkspaceProject, 'aliases'>): boolean {
  return project.aliases.some((alias) => alias.startsWith('repository:'));
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
  const tool = workspaces.find((place) => place.toolProject)?.toolProject?.name;
  if (tool) return tool;
  const repo = workspaces.flatMap(
    (place) => place.repoName ?? repoNameFromRemote(place.remotes?.[0]) ?? []
  )[0];
  if (repo) return repo;
  const readable = neoReadableFolderName(primary.folder ?? '');
  return GENERATED_FOLDER.test(primary.name) && readable ? readable : primary.name;
}

export function neoReadableFolderName(folder: string): string | null {
  return (
    folder
      .split(/[/\\]/)
      .filter(Boolean)
      .reverse()
      .find((segment) => !GENERATED_FOLDER.test(segment)) ?? null
  );
}

export function planNeoWorkspaceProjects(
  groups: readonly PlaceGroup[],
  plumbing: (place: Place) => boolean = () => false
): NeoWorkspaceProject[] {
  return groups
    .filter((group) => group.place.folder || group.place.toolProject)
    .flatMap((group) => {
      const workspaces = (group.workspaces ?? [group.place]).filter(
        (place) => !place.daemon && !plumbing(place)
      );
      if (!workspaces.length) return [];
      const work = group.work.filter((item) => !item.ref.daemon && !item.place.daemon);
      const primary = plumbing(group.place) || group.place.daemon ? workspaces[0] : group.place;
      return {
        aliases: [
          ...new Set([
            ...(group.projectId ? [group.projectId] : []),
            ...work.map(
              (item) => `work:${item.place.machine}\u0000${item.ref.adapter}\u0000${item.ref.id}`
            ),
            ...workspaces.flatMap((place) => [
              `folder:${placeKey(place)}`,
              ...(place.remotes ?? []).flatMap((remote) => {
                const alias = neoRepoAlias(remote);
                return alias ? [`${alias}${group.projectId ?? placeKey(place)}`] : [];
              }),
              ...(place.codeIdentity ? [place.codeIdentity] : []),
              ...[neoRepositoryIdentity(place.remotes?.[0])].flatMap((identity) => identity ?? []),
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

export function planNeoRepositoryBackfill(
  carriers: ReadonlyMap<string, readonly string[]>,
  owner: (alias: string) => string | null,
  project: (id: string) => { revision: number; createdAt: number; generated: boolean } | null,
  tool: (projectId: string) => boolean = () => false
): { alias: string; projectId: string }[] {
  const claims: { alias: string; projectId: string }[] = [];
  for (const [alias, ids] of carriers) {
    const live = [...new Set(ids)].flatMap((id) => {
      const found = project(id);
      return found ? [{ id, ...found }] : [];
    });
    const held = owner(alias);
    const ordered = [...live].sort(
      (a, b) =>
        Number(a.generated) - Number(b.generated) ||
        a.createdAt - b.createdAt ||
        (a.id < b.id ? -1 : 1)
    );
    const targetId = neoIdentityOwner(
      held && project(held) ? held : null,
      ordered.map((entry) => entry.id),
      tool
    );
    const target = targetId
      ? (live.find((entry) => entry.id === targetId) ?? { id: targetId, ...project(targetId)! })
      : null;
    if (!target) continue;
    if (held !== target.id) claims.push({ alias, projectId: target.id });
  }
  return claims;
}

export function backfillNeoRepositoryIdentities(db: Database): boolean {
  const repo = new NeoRepository(db);
  const owner = (alias: string) =>
    (
      db.prepare('SELECT project_id FROM neo_project_workspaces WHERE alias = ?').get(alias) as {
        project_id: string;
      } | null
    )?.project_id ?? null;
  const carriers = () => {
    const found = new Map<string, string[]>();
    for (const row of db
      .prepare("SELECT alias, project_id FROM neo_project_workspaces WHERE alias LIKE 'repo:%'")
      .all() as { alias: string; project_id: string }[]) {
      const identity = `repository:github.com/${row.alias.slice(5).split('\u0000')[0]}`;
      const projectId = repo.projectMerges.resolve(row.project_id);
      if (projectId) found.set(identity, [...(found.get(identity) ?? []), projectId]);
    }
    return found;
  };
  const project = (id: string) => {
    const found = repo.getProject(id);
    return found && repo.projectMerges.resolve(id) === id
      ? {
          revision: found.revision,
          createdAt: found.createdAt,
          generated: GENERATED_FOLDER.test(found.title),
        }
      : null;
  };
  const tool = neoToolProjects(db);
  let changed = false;
  for (const claim of planNeoRepositoryBackfill(carriers(), owner, project, tool)) {
    db.prepare(
      `INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)
      ON CONFLICT(alias) DO UPDATE SET project_id = excluded.project_id`
    ).run(claim.alias, claim.projectId);
    changed = true;
  }
  return changed;
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
      const tools = project.aliases.filter((alias) => alias.startsWith('tool:'));
      const keys = tools.length ? tools : identities.length ? identities : project.aliases;
      const known = keys.flatMap((alias) => {
        const row = db
          .prepare('SELECT project_id FROM neo_project_workspaces WHERE alias = ?')
          .get(alias) as { project_id: string } | null;
        return row ? [row.project_id] : [];
      });
      if (!known.length && !canNeoMirrorCreateProject(project)) continue;
      const id = known[0] ?? `project:${crypto.randomUUID()}`;
      if (!known.length) {
        changed = true;
        repo.saveProject(
          { id, title: project.title, summary: `Project: ${project.title}`, context: '' },
          0
        );
      }
      for (const alias of project.aliases) {
        db.prepare(
          `INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)
          ON CONFLICT(alias) DO UPDATE SET project_id = excluded.project_id
          WHERE excluded.alias LIKE 'folder:%' OR excluded.alias LIKE 'work:%'`
        ).run(alias, id);
      }
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
      return runLagPhase('neo:project_mirror:plan', () =>
        planNeoWorkspaceProjects(groups, (place) => isNeoPlumbingFolder(place, local))
      );
    },
    'groups',
    'projects'
  )
  .pipe(
    (db: Database, projects: readonly NeoWorkspaceProject[]) =>
      db.transaction(() => {
        const persisted = runLagPhase('neo:project_mirror:persist', () =>
          persistNeoWorkspaceProjects(db, projects)
        );
        return (
          runLagPhase('neo:project_mirror:backfill', () => backfillNeoRepositoryIdentities(db)) ||
          persisted
        );
      }, 'immediate')(),
    ['db', 'projects'],
    'changed'
  )
  .end('changed') as (db: Database, groups: readonly PlaceGroup[]) => boolean;

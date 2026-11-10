import type { Database } from '../../storage/sqlite-compat.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { sep } from 'node:path';
import type { Place, PlaceGroup } from '../drivers/types.ts';
import type { NeoProjectFacts } from './project-cleanup.ts';

export interface NeoWorkspaceProject {
  aliases: string[];
  identityAliases: readonly string[];
  title: string;
  create: boolean;
}

export interface NeoProjectIdentityPolicy {
  backfill(db: Database): boolean;
  facts(projects: readonly NeoProjectFacts[]): NeoProjectFacts[];
  mirroredAliases(places: readonly PlaceGroup[], plumbing: (place: Place) => boolean): Set<string>;
}

export function neoIdentityOwner(
  held: string | null,
  carriers: readonly string[],
  tool: (projectId: string) => boolean
): string | null {
  const standalone = [held ?? [], ...carriers].flat().find((id) => !tool(id));
  return standalone ?? held ?? carriers[0] ?? null;
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

export function persistNeoWorkspaceProjects(
  db: Database,
  projects: readonly NeoWorkspaceProject[]
): boolean {
  const repo = new NeoRepository(db);
  return db.transaction(() => {
    let changed = false;
    for (const project of projects) {
      const keys = project.identityAliases;
      const known = keys.flatMap((alias) => {
        const row = db
          .prepare('SELECT project_id FROM neo_project_workspaces WHERE alias = ?')
          .get(alias) as { project_id: string } | null;
        return row ? [row.project_id] : [];
      });
      if (!known.length && !project.create) continue;
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

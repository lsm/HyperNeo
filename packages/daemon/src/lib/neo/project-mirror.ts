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
import {
  mergeNeoDuplicateProjects,
  NEO_PROJECT_QUESTION_ATTEMPTS,
  neoProjectQuestionKey,
  readNeoProjectDecision,
  type NeoProjectMergeInput,
} from './project-merge.ts';
import { NeoAskRepository } from '../../storage/repositories/neo-ask-repository.ts';

export function neoProjectMergeAllowed(
  db: Database
): (a: string, b: string, sameRepository?: boolean) => boolean {
  const asks = new NeoAskRepository(db);
  return (a, b, sameRepository = false) => {
    const key = `neo-project-merge:${[a, b].sort().join('\u0000')}`;
    const found = [];
    for (let attempt = 1; attempt <= NEO_PROJECT_QUESTION_ATTEMPTS; attempt++) {
      const ask = asks.forRequest(neoProjectQuestionKey(key, attempt));
      if (!ask) break;
      found.push(ask);
    }
    if (!found.length) return true;
    const decision = readNeoProjectDecision(found, key);
    if ('decision' in decision && decision.decision !== 'pending')
      return decision.decision === 'same';
    return sameRepository;
  };
}

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

export function withdrawNeoProjectQuestions(db: Database, a: string, b: string): void {
  const asks = new NeoAskRepository(db);
  const key = `neo-project-merge:${[a, b].sort().join('\u0000')}`;
  for (let attempt = 1; attempt <= NEO_PROJECT_QUESTION_ATTEMPTS; attempt++) {
    const ask = asks.forRequest(neoProjectQuestionKey(key, attempt));
    if (!ask) break;
    if (ask.status === 'waiting' || ask.status === 'blocked' || ask.status === 'open')
      asks.settle(
        ask,
        'abandoned',
        'No longer needed: they share a repository, so they are one project.',
        'Merged by the repository rule.'
      );
  }
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

export function isNeoIdentityAlias(alias: string): boolean {
  return alias.startsWith('git:') || alias.startsWith('repository:');
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

export function planNeoMirrorMerges(
  projects: readonly NeoWorkspaceProject[],
  owner: (alias: string) => string | null,
  revision: (projectId: string) => number | null
): NeoProjectMergeInput[] {
  return projects.flatMap((project) => {
    const identities = project.aliases
      .filter(isNeoIdentityAlias)
      .sort((a, b) => Number(b.startsWith('repository:')) - Number(a.startsWith('repository:')));
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
  const allowed = neoProjectMergeAllowed(db);
  const tool = neoToolProjects(db);
  const owner = (alias: string) =>
    (
      db.prepare('SELECT project_id FROM neo_project_workspaces WHERE alias = ?').get(alias) as {
        project_id: string;
      } | null
    )?.project_id ?? null;
  return (
    mergeNeoDuplicateProjects(
      () =>
        planNeoMirrorMerges(projects, owner, (id) => repo.getProject(id)?.revision ?? null).filter(
          (input) =>
            !tool(input.sourceId) &&
            !tool(input.targetId) &&
            allowed(
              input.sourceId,
              input.targetId,
              input.sourceIdentities.some((identity) => identity.startsWith('repository:'))
            )
        ),
      (input) => repo.projectMerges.merge(input),
      () => {}
    ).map((merged) => withdrawNeoProjectQuestions(db, merged.sourceId, merged.targetId)).length > 0
  );
}

export function planNeoRepositoryBackfill(
  carriers: ReadonlyMap<string, readonly string[]>,
  owner: (alias: string) => string | null,
  project: (id: string) => { revision: number; createdAt: number; generated: boolean } | null,
  allowed: (a: string, b: string, sameRepository?: boolean) => boolean = () => true,
  tool: (projectId: string) => boolean = () => false
): { claims: { alias: string; projectId: string }[]; merges: NeoProjectMergeInput[] } {
  const claims: { alias: string; projectId: string }[] = [];
  const merges: NeoProjectMergeInput[] = [];
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
    for (const source of live)
      if (
        source.id !== target.id &&
        !tool(source.id) &&
        !tool(target.id) &&
        allowed(source.id, target.id, true)
      )
        merges.push({
          sourceId: source.id,
          targetId: target.id,
          sourceRevision: source.revision,
          targetRevision: target.revision,
          sourceIdentities: [alias],
          targetIdentities: [alias],
        });
  }
  return { claims, merges };
}

export function backfillNeoRepositoryIdentities(db: Database): boolean {
  const repo = new NeoRepository(db);
  const allowed = neoProjectMergeAllowed(db);
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
  for (const claim of planNeoRepositoryBackfill(carriers(), owner, project, allowed, tool).claims) {
    db.prepare(
      `INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)
      ON CONFLICT(alias) DO UPDATE SET project_id = excluded.project_id`
    ).run(claim.alias, claim.projectId);
    changed = true;
  }
  const merged = mergeNeoDuplicateProjects(
    () => planNeoRepositoryBackfill(carriers(), owner, project, allowed, tool).merges,
    (input) => repo.projectMerges.merge(input),
    () => {}
  );
  for (const pair of merged) withdrawNeoProjectQuestions(db, pair.sourceId, pair.targetId);
  return changed || merged.length > 0;
}

export function persistNeoWorkspaceProjects(
  db: Database,
  projects: readonly NeoWorkspaceProject[],
  allowed: (a: string, b: string) => boolean = () => true
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
        const held = (
          db
            .prepare('SELECT project_id FROM neo_project_workspaces WHERE alias = ?')
            .get(alias) as {
            project_id: string;
          } | null
        )?.project_id;
        if (held && held !== id && !allowed(held, id)) continue;
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
      return planNeoWorkspaceProjects(groups, (place) => isNeoPlumbingFolder(place, local));
    },
    'groups',
    'projects'
  )
  .pipe(
    (db: Database, projects: readonly NeoWorkspaceProject[]) => {
      const merged = mergeNeoMirroredDuplicates(db, projects);
      const persisted = persistNeoWorkspaceProjects(db, projects, neoProjectMergeAllowed(db));
      return backfillNeoRepositoryIdentities(db) || persisted || merged;
    },
    ['db', 'projects'],
    'changed'
  )
  .end('changed') as (db: Database, groups: readonly PlaceGroup[]) => boolean;

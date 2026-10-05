import { basename } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { Database } from '../../storage/sqlite-compat.ts';
import { skipSpaceQuery } from './hyperneo-adapter.ts';
import type { FindQuery, PlaceGroup, WorkAdapter, WorkStatus, WorkSummary } from './types.ts';

const OWN_THREADS = `cwd IS NOT NULL AND COALESCE(source, '') NOT LIKE '%subagent%'`;
const THREAD_COLUMNS = `id, COALESCE(NULLIF(name, ''), NULLIF(title, ''), NULLIF(substr(first_user_message, 1, 80), ''), 'Untitled thread') AS title,
  cwd AS folder, COALESCE(archived, 0) AS archived, COALESCE(updated_at_ms, 0) AS updatedAt`;
const THREADS_PER_PLACE = 20;
const CLOSED_THREADS = 500;
const RECENT_MS = 2 * 60_000;

export interface CodexRootRow {
  name: string;
  folder: string;
  lastActiveAt: number;
}

export interface CodexFolderRow {
  folder: string;
  openCount: number;
  archivedCount: number;
  lastActiveAt: number;
}

export interface CodexThreadRow {
  id: string;
  title: string;
  folder: string;
  archived: number;
  updatedAt: number;
}

export interface CodexSnapshot {
  roots: CodexRootRow[];
  folders: CodexFolderRow[];
  threads: CodexThreadRow[];
}

export interface CodexDesktopAdapterDeps {
  statePath: string;
  worktreesDir: string;
  machine: string;
  now: () => number;
}

interface CodexPlace extends CodexFolderRow {
  name: string;
  known: boolean;
}

export function readCodexSnapshot(statePath: string, includeClosed: boolean): CodexSnapshot {
  const db = new Database(statePath, { readonly: true });
  try {
    return {
      roots: db
        .prepare(
          `SELECT COALESCE(p.name, '') AS name, r.path AS folder,
             COALESCE(p.updated_at_ms, 0) AS lastActiveAt
             FROM projects p JOIN project_roots r ON r.project_id = p.id WHERE r.path IS NOT NULL`
        )
        .all() as CodexRootRow[],
      folders: db
        .prepare(
          `SELECT cwd AS folder, SUM(COALESCE(archived, 0) = 0) AS openCount,
             SUM(COALESCE(archived, 0) != 0) AS archivedCount,
             COALESCE(MAX(updated_at_ms), 0) AS lastActiveAt FROM threads WHERE ${OWN_THREADS} GROUP BY cwd`
        )
        .all() as CodexFolderRow[],
      threads: db
        .prepare(
          `SELECT * FROM (
             SELECT ${THREAD_COLUMNS} FROM threads WHERE ${OWN_THREADS} AND COALESCE(archived, 0) = 0
             UNION ALL
             SELECT * FROM (SELECT ${THREAD_COLUMNS} FROM threads
               WHERE ${OWN_THREADS} AND ? = 1 AND COALESCE(archived, 0) != 0
               ORDER BY updatedAt DESC LIMIT ${CLOSED_THREADS}))
           ORDER BY updatedAt DESC`
        )
        .all(includeClosed ? 1 : 0) as CodexThreadRow[],
    };
  } finally {
    db.close();
  }
}

export function codexProjectFolder(
  folder: string,
  roots: readonly CodexRootRow[],
  worktreesDir: string
): string {
  if (!folder.startsWith(`${worktreesDir}/`)) return folder;
  const matches = roots.filter((root) => basename(root.folder) === basename(folder));
  return matches.length === 1 ? matches[0].folder : folder;
}

function codexPlaces(snapshot: CodexSnapshot, worktreesDir: string): CodexPlace[] {
  const places = new Map<string, CodexPlace>();
  for (const root of snapshot.roots) {
    places.set(root.folder, {
      ...root,
      name: root.name || basename(root.folder) || root.folder,
      openCount: 0,
      archivedCount: 0,
      known: true,
    });
  }
  for (const row of snapshot.folders) {
    const folder = codexProjectFolder(row.folder, snapshot.roots, worktreesDir);
    const place = places.get(folder) ?? {
      folder,
      name: basename(folder) || folder,
      openCount: 0,
      archivedCount: 0,
      lastActiveAt: 0,
      known: false,
    };
    places.set(folder, {
      ...place,
      openCount: place.openCount + row.openCount,
      archivedCount: place.archivedCount + row.archivedCount,
      lastActiveAt: Math.max(place.lastActiveAt, row.lastActiveAt),
    });
  }
  return [...places.values()];
}

function codexStatus(thread: CodexThreadRow, now: number): WorkStatus {
  if (thread.archived) return 'stopped';
  return now - thread.updatedAt < RECENT_MS ? 'running' : 'done';
}

export function buildCodexGroups(
  snapshot: CodexSnapshot,
  query: FindQuery,
  deps: Omit<CodexDesktopAdapterDeps, 'statePath'>
): PlaceGroup[] {
  const text = query.text?.toLowerCase();
  const now = deps.now();
  return codexPlaces(snapshot, deps.worktreesDir)
    .filter((place) => !query.folder || place.folder === query.folder)
    .filter((place) => query.includeClosed || place.openCount > 0 || place.known)
    .flatMap((place) => {
      const placeMatches = !text || `${place.name} ${place.folder}`.toLowerCase().includes(text);
      const where = { machine: deps.machine, folder: place.folder, name: place.name };
      const work: WorkSummary[] = snapshot.threads
        .filter(
          (thread) =>
            codexProjectFolder(thread.folder, snapshot.roots, deps.worktreesDir) === place.folder
        )
        .filter((thread) => placeMatches || thread.title.toLowerCase().includes(text ?? ''))
        .slice(0, THREADS_PER_PLACE)
        .map((thread) => ({
          ref: { adapter: 'codex-desktop', id: thread.id },
          title: thread.title,
          place: where,
          status: codexStatus(thread, now),
          lastActivityAt: thread.updatedAt,
          link: `codex://threads/${thread.id}`,
        }));
      if (!placeMatches && work.length === 0) return [];
      return [
        {
          place: where,
          lastActivityAt: place.lastActiveAt,
          openCount: place.openCount,
          archivedCount: place.archivedCount,
          adapters: ['codex-desktop'],
          work,
        },
      ];
    });
}

export function loadCodexSnapshot(query: FindQuery, deps: CodexDesktopAdapterDeps): CodexSnapshot {
  return readCodexSnapshot(deps.statePath, query.includeClosed);
}

const runCodexFind = (superpipe({})('codex-find-work') as PipelineAPI)
  .input(['query', 'deps'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe(loadCodexSnapshot, ['query', 'deps'], 'snapshot')
  .pipe(buildCodexGroups, ['snapshot', 'query', 'deps'], 'groups')
  .end('groups') as (query: FindQuery, deps: CodexDesktopAdapterDeps) => PlaceGroup[];

export function createCodexDesktopAdapter(deps: CodexDesktopAdapterDeps): WorkAdapter {
  return {
    id: 'codex-desktop',
    capabilities: ['find'],
    find: (query) => runCodexFind(query, deps),
  };
}

import { basename } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type { FindQuery, PlaceGroup, WorkAdapter, WorkStatus, WorkSummary } from './types.ts';

const OPEN = `status IN ('active', 'paused', 'pending_worktree_choice')`;
const OWN_SESSIONS = `space_id IS NULL AND room_id IS NULL AND id NOT LIKE 'neo:%' AND type IN ('worker', 'general')`;
const FOLDER = 'COALESCE(main_repo_path, workspace_path)';
const SESSION_COLUMNS = `id, title, status, ${FOLDER} AS folder, last_active_at AS lastActiveAt,
  CASE WHEN json_valid(processing_state) THEN json_extract(processing_state, '$.status') END AS processing`;
const SESSIONS_PER_PLACE = 20;
const CLOSED_SESSIONS = 500;

export interface HyperneoPlaceRow {
  folder: string | null;
  openCount: number;
  archivedCount: number;
  known: number;
  lastActiveAt: string | null;
}

export interface HyperneoSessionRow {
  id: string;
  title: string;
  status: string;
  folder: string | null;
  processing: string | null;
  lastActiveAt: string | null;
}

export interface HyperneoAdapterDeps {
  db: () => BunDatabase;
  machine: string;
  searchSessionIds: (text: string) => ReadonlySet<string>;
}

export function hyperneoWorkStatus(status: string, processing: string | null): WorkStatus {
  if (status === 'archived' || status === 'ended' || processing === 'interrupted') return 'stopped';
  if (status === 'pending_worktree_choice' || processing === 'waiting_for_input')
    return 'needs_you';
  if (processing === 'processing') return 'running';
  return processing === 'queued' || processing === 'rate_limit_cooldown' ? 'queued' : 'done';
}

function timestamp(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function placeName(folder: string | null): string {
  return folder ? basename(folder.replace(/[\\/]+$/, '')) || folder : 'Chats';
}

export function readHyperneoPlaces(db: BunDatabase): HyperneoPlaceRow[] {
  return db
    .prepare(
      `SELECT folder, SUM(open) AS openCount, SUM(archived) AS archivedCount, MAX(known) AS known,
         MAX(lastActiveAt) AS lastActiveAt
         FROM (
           SELECT ${FOLDER} AS folder, CASE WHEN ${OPEN} THEN 1 ELSE 0 END AS open,
             CASE WHEN status = 'archived' THEN 1 ELSE 0 END AS archived, 0 AS known,
             last_active_at AS lastActiveAt
             FROM sessions WHERE ${OWN_SESSIONS}
           UNION ALL
           SELECT path, 0, 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ', last_used_at / 1000.0, 'unixepoch')
             FROM workspace_history
         )
        GROUP BY folder`
    )
    .all() as HyperneoPlaceRow[];
}

export function readHyperneoSessions(
  db: BunDatabase,
  includeClosed: boolean
): HyperneoSessionRow[] {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT ${SESSION_COLUMNS} FROM sessions WHERE ${OWN_SESSIONS} AND ${OPEN}
         UNION ALL
         SELECT * FROM (SELECT ${SESSION_COLUMNS} FROM sessions
           WHERE ${OWN_SESSIONS} AND ? = 1 AND NOT ${OPEN}
           ORDER BY lastActiveAt DESC LIMIT ${CLOSED_SESSIONS}))
       ORDER BY lastActiveAt DESC`
    )
    .all(includeClosed ? 1 : 0) as HyperneoSessionRow[];
}

function toWork(row: HyperneoSessionRow, machine: string): WorkSummary {
  return {
    ref: { adapter: 'hyperneo', id: row.id },
    title: row.title,
    place: { machine, ...(row.folder ? { folder: row.folder } : {}), name: placeName(row.folder) },
    status: hyperneoWorkStatus(row.status, row.processing),
    lastActivityAt: timestamp(row.lastActiveAt),
    link: `/session/${row.id}`,
  };
}

export function buildHyperneoGroups(
  places: readonly HyperneoPlaceRow[],
  sessions: readonly HyperneoSessionRow[],
  query: FindQuery,
  deps: Pick<HyperneoAdapterDeps, 'machine'>,
  matchedIds: ReadonlySet<string>
): PlaceGroup[] {
  if (query.spaceId) return [];
  const machine = deps.machine;
  const text = query.text?.toLowerCase();
  return places
    .filter((place) => !query.folder || place.folder === query.folder)
    .filter((place) => query.includeClosed || place.openCount > 0 || place.known > 0)
    .flatMap((place) => {
      const placeMatches =
        !text || `${placeName(place.folder)} ${place.folder ?? ''}`.toLowerCase().includes(text);
      const work = sessions
        .filter((session) => session.folder === place.folder)
        .filter(
          (session) =>
            placeMatches ||
            matchedIds.has(session.id) ||
            session.title.toLowerCase().includes(text ?? '')
        )
        .slice(0, SESSIONS_PER_PLACE)
        .map((session) => toWork(session, machine));
      if (!placeMatches && work.length === 0) return [];
      return [
        {
          place: {
            machine,
            ...(place.folder ? { folder: place.folder } : {}),
            name: placeName(place.folder),
          },
          lastActivityAt: timestamp(place.lastActiveAt),
          openCount: place.openCount,
          archivedCount: place.archivedCount,
          adapters: ['hyperneo'],
          work,
        },
      ];
    });
}

export function loadHyperneoPlaces(deps: HyperneoAdapterDeps): HyperneoPlaceRow[] {
  return readHyperneoPlaces(deps.db());
}

export function loadHyperneoSessions(
  query: FindQuery,
  deps: HyperneoAdapterDeps
): HyperneoSessionRow[] {
  return readHyperneoSessions(deps.db(), query.includeClosed);
}

export function matchHyperneoSessions(
  query: FindQuery,
  deps: HyperneoAdapterDeps
): ReadonlySet<string> {
  return query.text ? deps.searchSessionIds(query.text) : new Set();
}

const runHyperneoFind = (superpipe({})('hyperneo-find-work') as PipelineAPI)
  .input(['query', 'deps'])
  .pipe(loadHyperneoPlaces, 'deps', 'places')
  .pipe(loadHyperneoSessions, ['query', 'deps'], 'sessions')
  .pipe(matchHyperneoSessions, ['query', 'deps'], 'matchedIds')
  .pipe(buildHyperneoGroups, ['places', 'sessions', 'query', 'deps', 'matchedIds'], 'groups')
  .end('groups') as (query: FindQuery, deps: HyperneoAdapterDeps) => PlaceGroup[];

export function createHyperneoAdapter(deps: HyperneoAdapterDeps): WorkAdapter {
  return {
    id: 'hyperneo',
    capabilities: ['find'],
    find: (query) => runHyperneoFind(query, deps),
  };
}

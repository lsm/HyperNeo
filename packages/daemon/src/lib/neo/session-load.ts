import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import { hyperNeoSessionsWorkStatus } from '../drivers/hyperneo-sessions-adapter.ts';
import type { NeoSessionLoad } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoDriverTarget } from './driver-work.ts';

export interface NeoIdleSession {
  sessionId: string;
  title: string;
}

interface LoadRow {
  sessionId: string;
  liveCards: number;
  status: string | null;
  processing: string | null;
}

const PROCESSING = `CASE WHEN json_valid(s.processing_state) THEN CASE
  WHEN json_extract(s.processing_state, '$.status') = 'interrupted'
    AND json_extract(s.processing_state, '$.reason') = 'restart' THEN 'interrupted_by_restart'
  ELSE json_extract(s.processing_state, '$.status') END END`;
const IDLE_LIMIT = 3;

function busyStatus(status: string | null, processing: string | null): boolean {
  if (!status) return false;
  const work = hyperNeoSessionsWorkStatus(status, processing);
  return work === 'running' || work === 'queued';
}

const LOAD_TABLES = ['neo_work', 'neo_work_driver_targets', 'sessions'];
const SESSION_COLUMNS = ['status', 'processing_state', 'workspace_path', 'main_repo_path'];

function hasLoadTables(db: BunDatabase): boolean {
  const tables = db
    .prepare(
      `SELECT COUNT(*) AS found FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)`
    )
    .get(...LOAD_TABLES) as { found: number };
  if (tables.found !== LOAD_TABLES.length) return false;
  const columns = new Set(
    (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  return SESSION_COLUMNS.every((column) => columns.has(column));
}

export function readNeoSessionLoad(db: BunDatabase, excludeRequestKey?: string): NeoSessionLoad[] {
  if (!hasLoadTables(db)) return [];
  const rows = db
    .prepare(
      `SELECT live.sessionId AS sessionId, COUNT(*) AS liveCards, s.status AS status,
         ${PROCESSING} AS processing
         FROM (
           SELECT COALESCE(w.session_id, w.target_session_id) AS sessionId
             FROM neo_work w
            WHERE w.status IN ('proposed', 'queued') AND w.request_key IS NOT ?
              AND NOT EXISTS (SELECT 1 FROM neo_work_driver_targets t WHERE t.work_id = w.id)
           UNION ALL
           SELECT COALESCE(json_extract(t.ref, '$.id'), json_extract(t.target, '$.ref.id'))
             FROM neo_work w JOIN neo_work_driver_targets t ON t.work_id = w.id
            WHERE w.status IN ('proposed', 'queued') AND w.request_key IS NOT ?
              AND COALESCE(json_extract(t.ref, '$.adapter'), json_extract(t.target, '$.ref.adapter')) = 'hyperneo-sessions'
              AND COALESCE(json_extract(t.ref, '$.daemon'), json_extract(t.target, '$.ref.daemon')) IS NULL
         ) live
         LEFT JOIN sessions s ON s.id = live.sessionId
        WHERE live.sessionId IS NOT NULL
        GROUP BY live.sessionId`
    )
    .all(excludeRequestKey ?? null, excludeRequestKey ?? null) as LoadRow[];
  return rows.map((row) => ({
    sessionId: row.sessionId,
    liveCards: row.liveCards,
    busy: busyStatus(row.status, row.processing),
  }));
}

export function hasNeoWorkRequest(db: BunDatabase, requestKey: string): boolean {
  return !!db.prepare('SELECT 1 FROM neo_work WHERE request_key = ?').get(requestKey);
}

export function readNeoIdleSessions(
  db: BunDatabase,
  nearSessionId: string,
  loaded: ReadonlySet<string>
): NeoIdleSession[] {
  if (!hasLoadTables(db)) return [];
  const rows = db
    .prepare(
      `SELECT s.id AS sessionId, s.title AS title, s.status AS status, ${PROCESSING} AS processing
         FROM sessions s
         JOIN sessions near ON near.id = ?
        WHERE s.id != near.id
          AND COALESCE(s.main_repo_path, s.workspace_path) IS COALESCE(near.main_repo_path, near.workspace_path)
          AND s.space_id IS NULL AND s.room_id IS NULL AND s.id NOT LIKE 'neo:%'
          AND s.type IN ('worker', 'general') AND s.status = 'active'
        ORDER BY s.last_active_at DESC
        LIMIT 50`
    )
    .all(nearSessionId) as Array<NeoIdleSession & { status: string; processing: string | null }>;
  return rows
    .filter((row) => !loaded.has(row.sessionId) && !busyStatus(row.status, row.processing))
    .slice(0, IDLE_LIMIT)
    .map(({ sessionId, title }) => ({ sessionId, title }));
}

export function neoTargetSessionId(
  targetSessionId: string | null | undefined,
  work: NeoDriverTarget | undefined
): string | null {
  if (targetSessionId) return targetSessionId;
  if (work?.verb === 'send' && work.ref.adapter === 'hyperneo-sessions' && !work.ref.daemon) {
    return work.ref.id;
  }
  return null;
}

export function requireIdleNeoTarget(
  sessionId: string | null,
  load: readonly NeoSessionLoad[],
  allowBusyTarget: boolean | undefined,
  idle: (sessionId: string, loaded: ReadonlySet<string>) => readonly NeoIdleSession[]
): { value: true } | { reason: { ok: false; reason: string } } {
  if (!sessionId || allowBusyTarget) return { value: true };
  const held = load.find((entry) => entry.sessionId === sessionId);
  if (!held) return { value: true };
  const alternatives = idle(sessionId, new Set(load.map((entry) => entry.sessionId)));
  const where = alternatives.length
    ? `Idle sessions in the same place: ${alternatives
        .map((session) => `${session.sessionId} (${session.title})`)
        .join(
          ', '
        )}. Propose there with targetSessionId or work {verb:"send"}, or start new work in that place.`
    : 'No idle session shares its place; start new work there with work {verb:"start"}.';
  return {
    reason: {
      ok: false,
      reason: `Session ${sessionId} already holds ${held.liveCards} live card${
        held.liveCards === 1 ? '' : 's'
      }${held.busy ? ' and is busy' : ''}. ${where} Pass allowBusyTarget:true only to queue this behind its current work on purpose.`,
    },
  };
}

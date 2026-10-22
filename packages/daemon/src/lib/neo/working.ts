import { workerIdentity } from '@hyperneo/shared/types/worker-identity';
import type { NeoWorkingSession, NeoWorkingStatus } from '@hyperneo/shared/types/neo-snapshot';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';

type Row = {
  sessionId: string;
  projectId: string | null;
  title: string | null;
  status: string | null;
  name?: string | null;
};

const WORKING = new Set<string>(['queued', 'processing', 'rate_limit_cooldown']);

export function projectNeoWorking(rows: readonly Row[]): NeoWorkingSession[] {
  return rows
    .filter((row) => WORKING.has(row.status ?? ''))
    .map((row) => ({
      sessionId: row.sessionId,
      worker: workerIdentity({ adapter: 'hyperneo', id: row.sessionId }, row.name ?? null),
      projectId: row.projectId,
      title: row.title ?? 'Neo',
      status: row.status as NeoWorkingStatus,
    }))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

export function neoWorkingKey(working: readonly NeoWorkingSession[]): string {
  return JSON.stringify(working);
}

export function readNeoWorking(db: BunDatabase): NeoWorkingSession[] {
  const columns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'processing_state')) return [];
  return projectNeoWorking(
    db
      .prepare(
        `SELECT b.session_id AS sessionId, b.concern_id AS projectId, c.title AS title, s.title AS name,
           CASE WHEN json_valid(s.processing_state)
             THEN json_extract(s.processing_state, '$.status') END AS status
           FROM neo_session_bindings b
           JOIN sessions s ON s.id = b.session_id
           LEFT JOIN neo_concerns c ON c.id = b.concern_id
          WHERE b.kind = 'neo' AND s.status IS NOT 'archived'`
      )
      .all() as Row[]
  );
}

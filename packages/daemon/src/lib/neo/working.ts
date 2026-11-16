import { workerIdentity } from '@hyperneo/shared/types/worker-identity';
import { modelHoldOf } from '@hyperneo/shared/types/model-hold';
import type { NeoWorkingSession, NeoWorkingStatus } from '@hyperneo/shared/types/neo-snapshot';
import type { RateLimitHoldReason } from '@hyperneo/shared/state-types';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import { frontSessionId } from './front-mode.ts';

type Row = {
  sessionId: string;
  projectId: string | null;
  title: string | null;
  status: string | null;
  name?: string | null;
  role?: 'neo' | 'front' | null;
  provider?: string | null;
  reason?: RateLimitHoldReason | null;
  since?: number | null;
  retryAt?: number | null;
};

const WORKING = new Set<string>(['queued', 'processing', 'rate_limit_cooldown']);

const listed = (row: Row) =>
  row.role === 'front' ? row.status === 'rate_limit_cooldown' : WORKING.has(row.status ?? '');

export function projectNeoWorking(rows: readonly Row[]): NeoWorkingSession[] {
  return rows
    .filter(listed)
    .map((row) => {
      const modelHold = row.role
        ? modelHoldOf({ ...row, status: row.status ?? '' }, row.provider ?? '')
        : undefined;
      return {
        sessionId: row.sessionId,
        worker: workerIdentity({ adapter: 'hyperneo', id: row.sessionId }, row.name ?? null),
        projectId: row.projectId,
        title: row.title ?? 'Neo',
        status: row.status as NeoWorkingStatus,
        ...(row.role ? { role: row.role } : {}),
        ...(modelHold ? { modelHold } : {}),
      };
    })
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

export function neoWorkingKey(working: readonly NeoWorkingSession[]): string {
  return JSON.stringify(working);
}

const STATE = (field: string) =>
  `CASE WHEN json_valid(s.processing_state) THEN json_extract(s.processing_state, '$.${field}') END`;

const SESSION_FIELDS = `s.title AS name, ${STATE('status')} AS status, ${STATE('reason')} AS reason,
  ${STATE('since')} AS since, ${STATE('retryAt')} AS retryAt,
  CASE WHEN json_valid(s.config) THEN json_extract(s.config, '$.provider') END AS provider`;

export function readNeoWorking(
  db: BunDatabase,
  conversationId: string | null
): NeoWorkingSession[] {
  const columns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'processing_state')) return [];
  return projectNeoWorking(
    db
      .prepare(
        `SELECT b.session_id AS sessionId, b.concern_id AS projectId, c.title AS title,
           CASE WHEN b.concern_id IS NULL THEN 'neo' END AS role, ${SESSION_FIELDS}
           FROM neo_session_bindings b
           JOIN sessions s ON s.id = b.session_id
           LEFT JOIN neo_concerns c ON c.id = b.concern_id
          WHERE b.kind = 'neo' AND s.status IS NOT 'archived'
         UNION ALL
         SELECT s.id, NULL, NULL, 'front', ${SESSION_FIELDS}
           FROM sessions s WHERE s.id = ? AND s.status IS NOT 'archived'`
      )
      .all(conversationId ? frontSessionId(conversationId) : null) as Row[]
  );
}

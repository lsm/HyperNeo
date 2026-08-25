import { Logger } from '../../lib/logger.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

const log = new Logger('migration-214');

function tableExists(db: BunDatabase, tableName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
  return !!result;
}

export function runMigration214(db: BunDatabase): void {
  if (!tableExists(db, 'sessions') || !tableExists(db, 'node_executions')) return;

  const result = db
    .prepare(
      `UPDATE sessions
       SET metadata = json_set(
             COALESCE(metadata, '{}'),
             '$.promptProvenance.agentName', (
               SELECT ne.agent_name
               FROM node_executions ne
               WHERE ne.agent_session_id = sessions.id
               ORDER BY ne.updated_at DESC, ne.id DESC
               LIMIT 1
             )
           )
       WHERE type = 'worker'
         AND json_extract(metadata, '$.promptProvenance.agentName') IS NULL
         AND EXISTS (
           SELECT 1 FROM node_executions ne
           WHERE ne.agent_session_id = sessions.id
             AND ne.agent_name IS NOT NULL
         )`
    )
    .run();

  if (result.changes > 0) {
    log.info(
      `[backfill] Stamped promptProvenance.agentName on ${result.changes} worker session(s) from node_executions.`
    );
  }
}

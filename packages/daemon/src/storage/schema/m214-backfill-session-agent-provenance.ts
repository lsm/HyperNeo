import { Logger } from '../../lib/logger.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

const log = new Logger('migration-214');

function tableExists(db: BunDatabase, tableName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
  return !!result;
}

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  return !!db
    .prepare(`SELECT name FROM pragma_table_info('${tableName}') WHERE name = ?`)
    .get(columnName);
}

export function runMigration214(db: BunDatabase): void {
  if (!tableExists(db, 'sessions') || !tableExists(db, 'node_executions')) return;
  if (
    !tableHasColumn(db, 'sessions', 'metadata') ||
    !tableHasColumn(db, 'sessions', 'type') ||
    !tableHasColumn(db, 'node_executions', 'agent_name') ||
    !tableHasColumn(db, 'node_executions', 'agent_session_id')
  ) {
    return;
  }

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

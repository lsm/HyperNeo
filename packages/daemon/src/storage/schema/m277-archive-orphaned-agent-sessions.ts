import type { Database } from '../sqlite-compat.ts';

function tableExists(db: Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function hasColumns(db: Database, table: string, columns: string[]): boolean {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
  );
  return columns.every((column) => present.has(column));
}

export function runMigration277(db: Database, now = new Date().toISOString()): void {
  if (
    !tableExists(db, 'space_long_horizon_agents') ||
    !hasColumns(db, 'sessions', ['space_id', 'status', 'archived_at', 'metadata'])
  ) {
    return;
  }
  db.prepare(
    `UPDATE sessions SET status = 'archived', archived_at = ?
     WHERE space_id IS NOT NULL
       AND status != 'archived'
       AND json_valid(metadata)
       AND json_extract(metadata, '$.promptProvenance.agentId') IS NOT NULL
       AND json_extract(metadata, '$.promptProvenance.agentId') NOT IN (
         SELECT id FROM space_long_horizon_agents
       )`
  ).run(now);
}

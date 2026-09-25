import type { Database } from '../sqlite-compat.ts';

function tableExists(db: Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

export function runMigration277(db: Database, now = new Date().toISOString()): void {
  if (!tableExists(db, 'sessions') || !tableExists(db, 'space_long_horizon_agents')) return;
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

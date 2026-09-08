import { SPACE_MANAGER_HANDLE } from '../../lib/space/agent-handle.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}

export function runMigration240(db: BunDatabase): void {
  if (!tableExists(db, 'space_long_horizon_agents')) return;
  const now = Date.now();
  db.prepare(
    `UPDATE space_long_horizon_agents
        SET handle = 'space-manager-migrated-' || replace(id, ':', '-'), updated_at = ?
      WHERE handle = ?
        AND status != 'archived'
        AND space_id IN (SELECT space_id FROM space_long_horizon_agents WHERE handle = 'coordinator')`
  ).run(now, SPACE_MANAGER_HANDLE);
  db.prepare(
    `UPDATE space_long_horizon_agents
        SET handle = ?, updated_at = ?
      WHERE handle = 'coordinator'`
  ).run(SPACE_MANAGER_HANDLE, now);
}

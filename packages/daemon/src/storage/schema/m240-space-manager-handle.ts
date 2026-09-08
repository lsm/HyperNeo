import { SPACE_MANAGER_HANDLE } from '../../lib/space/agent-handle.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}

interface AgentIdRow {
  id: string;
  space_id: string;
}

interface HandleRow {
  handle: string;
}

export function runMigration240(db: BunDatabase): void {
  if (!tableExists(db, 'space_long_horizon_agents')) return;
  const now = Date.now();
  const holders = db
    .prepare(
      `SELECT id, space_id FROM space_long_horizon_agents
        WHERE handle = ? AND status != 'archived'
          AND space_id IN (SELECT space_id FROM space_long_horizon_agents WHERE handle = 'coordinator')`
    )
    .all(SPACE_MANAGER_HANDLE) as AgentIdRow[];
  db.exec('BEGIN');
  try {
    const activeHandles = db.prepare(
      `SELECT handle FROM space_long_horizon_agents WHERE space_id = ? AND status != 'archived'`
    );
    const rehandle = db.prepare(
      `UPDATE space_long_horizon_agents SET handle = ?, updated_at = ? WHERE id = ?`
    );
    const usedBySpace = new Map<string, Set<string>>();
    for (const holder of holders) {
      const used =
        usedBySpace.get(holder.space_id) ??
        new Set((activeHandles.all(holder.space_id) as HandleRow[]).map((row) => row.handle));
      usedBySpace.set(holder.space_id, used);
      const base = `space-manager-migrated-${holder.id.replace(/:/g, '-')}`;
      let handle = base;
      let attempt = 2;
      while (used.has(handle)) {
        handle = `${base}-${attempt++}`;
      }
      rehandle.run(handle, now, holder.id);
      used.add(handle);
    }
    db.prepare(
      `UPDATE space_long_horizon_agents SET handle = ?, updated_at = ? WHERE handle = 'coordinator'`
    ).run(SPACE_MANAGER_HANDLE, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

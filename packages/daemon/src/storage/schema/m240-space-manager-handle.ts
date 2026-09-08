import { SPACE_MANAGER_HANDLE } from '../../lib/space/agent-handle.ts';
import { slugifyWithinLimit } from '../../lib/space/slug.ts';
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
        WHERE handle = ?
          AND space_id IN (
            SELECT space_id FROM space_long_horizon_agents
             WHERE handle = 'coordinator'
                OR id = 'space-lh-agent:coordinator:' || space_id
          )`
    )
    .all(SPACE_MANAGER_HANDLE) as AgentIdRow[];
  db.exec('BEGIN');
  try {
    const spaceHandles = db.prepare(
      `SELECT handle FROM space_long_horizon_agents WHERE space_id = ?`
    );
    const rehandle = db.prepare(
      `UPDATE space_long_horizon_agents SET handle = ?, updated_at = ? WHERE id = ?`
    );
    const usedBySpace = new Map<string, Set<string>>();
    for (const holder of holders) {
      const used =
        usedBySpace.get(holder.space_id) ??
        new Set((spaceHandles.all(holder.space_id) as HandleRow[]).map((row) => row.handle));
      usedBySpace.set(holder.space_id, used);
      const handle = slugifyWithinLimit(`space-manager-migrated-${holder.id.replace(/:/g, '-')}`, [
        ...used,
      ]);
      rehandle.run(handle, now, holder.id);
      used.add(handle);
    }
    db.prepare(
      `UPDATE space_long_horizon_agents
          SET handle = ?,
              display_name = CASE
                WHEN display_name = 'Coordinator' AND NOT EXISTS (
                  SELECT 1 FROM space_long_horizon_agents other
                   WHERE other.space_id = space_long_horizon_agents.space_id
                     AND other.handle != 'coordinator'
                     AND other.status != 'archived'
                     AND lower(trim(other.display_name)) = 'space manager'
                ) THEN 'Space Manager' ELSE display_name END,
              updated_at = ?
        WHERE handle = 'coordinator'`
    ).run(SPACE_MANAGER_HANDLE, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

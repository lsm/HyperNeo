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

interface AgentRow {
  id: string;
  space_id: string;
  handle: string;
  display_name: string;
}

function normalizeDisplayName(value: string): string {
  return value.trim().toLowerCase();
}

export function runMigration240(db: BunDatabase): void {
  if (!tableExists(db, 'space_long_horizon_agents')) return;
  const now = Date.now();
  const holders = db
    .prepare(
      `SELECT id, space_id FROM space_long_horizon_agents
        WHERE (
          handle = ?
          AND id != 'space-lh-agent:coordinator:' || space_id
          AND space_id IN (
            SELECT space_id FROM space_long_horizon_agents
             WHERE handle = 'coordinator'
                OR id = 'space-lh-agent:coordinator:' || space_id
          )
        ) OR (
          handle = 'coordinator'
          AND id != 'space-lh-agent:coordinator:' || space_id
          AND (
            status = 'archived'
            OR EXISTS (
              SELECT 1 FROM space_long_horizon_agents det
               WHERE det.space_id = space_long_horizon_agents.space_id
                 AND det.id = 'space-lh-agent:coordinator:' || space_id
                 AND det.handle != 'coordinator'
            )
          )
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
    const agents = db
      .prepare(`SELECT id, space_id, handle, display_name FROM space_long_horizon_agents`)
      .all() as AgentRow[];
    const originalHandles = new Map(agents.map((row) => [row.id, row.handle]));
    const legacyHandleIds = new Set(
      agents.filter((row) => row.handle === 'coordinator').map((row) => row.id)
    );
    db.prepare(
      `UPDATE space_long_horizon_agents SET handle = ?, updated_at = ? WHERE handle = 'coordinator'`
    ).run(SPACE_MANAGER_HANDLE, now);
    const bySpace = new Map<string, AgentRow[]>();
    for (const row of agents) {
      const spaceRows = bySpace.get(row.space_id) ?? [];
      spaceRows.push(row);
      bySpace.set(row.space_id, spaceRows);
    }
    const restamp = db.prepare(
      `UPDATE space_long_horizon_agents SET display_name = ?, updated_at = ? WHERE id = ?`
    );
    for (const row of agents) {
      if (row.display_name !== 'Coordinator') continue;
      const wasLegacy = legacyHandleIds.has(row.id);
      const isDeterministic = row.id === `space-lh-agent:coordinator:${row.space_id}`;
      if (!wasLegacy && !isDeterministic) continue;
      const collides = (bySpace.get(row.space_id) ?? []).some(
        (other) =>
          other.id !== row.id &&
          (!wasLegacy || originalHandles.get(other.id) !== 'coordinator') &&
          normalizeDisplayName(other.display_name) === 'space manager'
      );
      if (!collides) restamp.run('Space Manager', now, row.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

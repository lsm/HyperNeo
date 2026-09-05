import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function runMigration232(db: BunDatabase): void {
  if (!tableExists(db, 'space_agents')) return;

  const uncopied = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM space_agents workers
       LEFT JOIN space_long_horizon_agents copied
         ON copied.id = workers.id AND copied.space_id = workers.space_id
       WHERE copied.id IS NULL`
    )
    .get() as { count: number };
  if (uncopied.count > 0) {
    const collisions = db
      .prepare(
        `SELECT workers.id AS worker_id, workers.space_id AS space_id
         FROM space_agents workers
         JOIN space_long_horizon_agents existing ON existing.id = workers.id
         WHERE existing.space_id != workers.space_id
         LIMIT 5`
      )
      .all() as Array<{ worker_id: string; space_id: string }>;
    const detail =
      collisions.length > 0
        ? ` Cross-space id collisions: ${collisions
            .map((row) => `${row.worker_id} in space ${row.space_id}`)
            .join(', ')}.`
        : '';
    throw new Error(
      `Migration 232 found ${uncopied.count} space_agents row(s) missing from ` +
        `space_long_horizon_agents; refusing to drop the legacy table.${detail}`
    );
  }

  db.exec('BEGIN');
  try {
    db.exec('DROP TABLE IF EXISTS space_agent_goal_assignments');
    db.exec('DROP TABLE IF EXISTS space_agent_forge_scope_assignments');
    db.exec('DROP TABLE IF EXISTS space_agent_reminders');
    db.exec('DROP TABLE space_agents');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}

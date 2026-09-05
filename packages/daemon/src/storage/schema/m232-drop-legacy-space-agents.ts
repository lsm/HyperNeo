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
    const missing = db
      .prepare(
        `SELECT workers.id AS worker_id, workers.space_id AS space_id
         FROM space_agents workers
         LEFT JOIN space_long_horizon_agents copied
           ON copied.id = workers.id AND copied.space_id = workers.space_id
         WHERE copied.id IS NULL
         LIMIT 5`
      )
      .all() as Array<{ worker_id: string; space_id: string }>;
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
        `space_long_horizon_agents: ${missing
          .map((row) => `${row.worker_id} in space ${row.space_id}`)
          .join(', ')}. Refusing to drop the legacy table.${detail}`
    );
  }

  const undrainedChecks: Array<{ tableName: string; sql: string }> = [
    {
      tableName: 'space_agent_goal_assignments',
      sql: `
        SELECT legacy.agent_id AS agent_id, legacy.goal_id AS target_id
        FROM space_agent_goal_assignments legacy
        JOIN space_long_horizon_agents live
          ON live.id = legacy.agent_id AND live.space_id = legacy.space_id
        WHERE NOT EXISTS (
          SELECT 1 FROM space_long_horizon_agent_goals copied
          WHERE copied.agent_id = legacy.agent_id AND copied.goal_id = legacy.goal_id
        )
        AND EXISTS (
          SELECT 1 FROM space_goals goal
          WHERE goal.id = legacy.goal_id AND goal.space_id = legacy.space_id
        )`,
    },
    {
      tableName: 'space_agent_forge_scope_assignments',
      sql: `
        SELECT legacy.agent_id AS agent_id, legacy.scope_id AS target_id
        FROM space_agent_forge_scope_assignments legacy
        JOIN space_long_horizon_agents live
          ON live.id = legacy.agent_id AND live.space_id = legacy.space_id
        WHERE NOT EXISTS (
          SELECT 1 FROM space_long_horizon_agent_forge_scopes copied
          WHERE copied.agent_id = legacy.agent_id AND copied.scope_id = legacy.scope_id
        )
        AND EXISTS (
          SELECT 1 FROM evolution_scopes scope
          WHERE scope.id = legacy.scope_id AND scope.space_id = legacy.space_id
        )`,
    },
    {
      tableName: 'space_agent_reminders',
      sql: `
        SELECT legacy.agent_id AS agent_id, legacy.id AS target_id
        FROM space_agent_reminders legacy
        JOIN space_long_horizon_agents live
          ON live.id = legacy.agent_id AND live.space_id = legacy.space_id
        WHERE legacy.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM space_long_horizon_agent_reminders copied
            WHERE copied.id = legacy.id
          )`,
    },
  ];
  const undrained = undrainedChecks
    .filter((check) => tableExists(db, check.tableName))
    .flatMap((check) =>
      (
        db.prepare(`${check.sql} LIMIT 5`).all() as Array<{
          agent_id: string;
          target_id: string;
        }>
      ).map((row) => ({ tableName: check.tableName, ...row }))
    );
  if (undrained.length > 0) {
    throw new Error(
      `Migration 232 found undrained legacy assignment rows whose only copy would be ` +
        `destroyed by the drop: ${undrained
          .map((row) => `${row.tableName} ${row.agent_id} → ${row.target_id}`)
          .join(', ')}. Refusing to drop; the pre-migration backup retains them.`
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

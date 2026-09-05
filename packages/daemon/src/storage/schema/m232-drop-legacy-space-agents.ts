import { Logger } from '../../lib/logger.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

const log = new Logger('migration-232');

export function runMigration232(db: BunDatabase): void {
  if (!tableExists(db, 'space_agents')) return;

  warnUncopiedAgents(db);
  warnDroppedAssignmentGhosts(db);

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

function warnUncopiedAgents(db: BunDatabase): void {
  const missing = db
    .prepare(
      `SELECT workers.id AS agent_id, workers.space_id AS space_id
       FROM space_agents workers
       LEFT JOIN space_long_horizon_agents copied
         ON copied.id = workers.id AND copied.space_id = workers.space_id
       WHERE copied.id IS NULL
       LIMIT 5`
    )
    .all() as Array<{ agent_id: string; space_id: string }>;
  if (missing.length === 0) return;
  log.warn(
    `Migration 232 found space_agents rows with no space_long_horizon_agents counterpart: ` +
      `${missing.map((row) => `${row.agent_id} in space ${row.space_id}`).join(', ')}. ` +
      `These are either workers migration 223 could not copy or agents deleted on the ` +
      `unified side after migration 223; either way their row exists only in the ` +
      `pre-migration backup and is dropped with the legacy table.`
  );
}

function warnDroppedAssignmentGhosts(db: BunDatabase): void {
  const ghostChecks: Array<{ tableName: string; sql: string }> = [
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
  for (const check of ghostChecks) {
    if (!tableExists(db, check.tableName)) continue;
    const ghosts = db.prepare(`${check.sql} LIMIT 5`).all() as Array<{
      agent_id: string;
      target_id: string;
    }>;
    if (ghosts.length === 0) continue;
    log.warn(
      `Migration 232 is dropping ${check.tableName} rows whose only copy may be here: ` +
        `${ghosts.map((row) => `${row.agent_id} → ${row.target_id}`).join(', ')}. ` +
        `Migration 155 never deleted legacy rows, so these are either assignments it ` +
        `skipped or ones the user later removed or transferred on the unified side; ` +
        `restoring them would reverse those decisions, so they are dropped and remain ` +
        `recoverable only from the pre-migration backup.`
    );
  }
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}

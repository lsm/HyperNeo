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

  db.exec('BEGIN');
  try {
    recopyLiveGoalAssignments(db);
    recopyLiveForgeScopeAssignments(db);
    recopyLiveReminders(db);
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

function recopyLiveGoalAssignments(db: BunDatabase): void {
  if (!tableExists(db, 'space_agent_goal_assignments')) return;
  db.prepare(
    `INSERT OR IGNORE INTO space_long_horizon_agent_goals (
       agent_id, goal_id, relationship, created_at, updated_at
     )
     SELECT legacy.agent_id, legacy.goal_id, 'owner', legacy.created_at, legacy.created_at
     FROM space_agent_goal_assignments legacy
     JOIN space_long_horizon_agents live
       ON live.id = legacy.agent_id AND live.space_id = legacy.space_id
     JOIN space_goals goal
       ON goal.id = legacy.goal_id AND goal.space_id = legacy.space_id`
  ).run();
}

function recopyLiveForgeScopeAssignments(db: BunDatabase): void {
  if (!tableExists(db, 'space_agent_forge_scope_assignments')) return;
  db.prepare(
    `INSERT OR IGNORE INTO space_long_horizon_agent_forge_scopes (
       agent_id, scope_id, relationship, created_at, updated_at
     )
     SELECT legacy.agent_id, legacy.scope_id, 'owner', legacy.created_at, legacy.created_at
     FROM space_agent_forge_scope_assignments legacy
     JOIN space_long_horizon_agents live
       ON live.id = legacy.agent_id AND live.space_id = legacy.space_id
     JOIN evolution_scopes scope
       ON scope.id = legacy.scope_id AND scope.space_id = legacy.space_id`
  ).run();
}

function recopyLiveReminders(db: BunDatabase): void {
  if (!tableExists(db, 'space_agent_reminders')) return;
  db.prepare(
    `INSERT OR IGNORE INTO space_long_horizon_agent_reminders (
       id, space_id, agent_id, title, body, status, trigger_type, run_at, cron_expression,
       timezone, next_run_at, last_fired_at, created_by_session, created_at, updated_at
     )
     SELECT
       legacy.id,
       legacy.space_id,
       legacy.agent_id,
       legacy.message,
       '',
       CASE legacy.status
         WHEN 'done' THEN 'fired'
         WHEN 'cancelled' THEN 'cancelled'
         ELSE 'active'
       END,
       'at',
       legacy.remind_at,
       NULL,
       'UTC',
       CASE legacy.status WHEN 'active' THEN legacy.remind_at ELSE NULL END,
       CASE legacy.status WHEN 'done' THEN legacy.remind_at ELSE NULL END,
       NULL,
       legacy.created_at,
       legacy.updated_at
     FROM space_agent_reminders legacy
     JOIN space_long_horizon_agents live
       ON live.id = legacy.agent_id AND live.space_id = legacy.space_id`
  ).run();
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}

import type { Database as BunDatabase } from 'bun:sqlite';

export interface LegacyLongHorizonMigrationReport {
  copiedGoals: number;
  skippedGoals: number;
  copiedForgeScopes: number;
  skippedForgeScopes: number;
  copiedReminders: number;
  skippedReminders: number;
}

export function migrateLegacyLongHorizonAgentData(
  db: BunDatabase
): LegacyLongHorizonMigrationReport {
  const copiedGoals = copyLegacyGoals(db);
  const skippedGoals = countSkippedLegacyRows(db, 'space_agent_goal_assignments');
  const copiedForgeScopes = copyLegacyForgeScopes(db);
  const skippedForgeScopes = countSkippedLegacyRows(db, 'space_agent_forge_scope_assignments');
  const copiedReminders = copyLegacyReminders(db);
  const skippedReminders = countSkippedLegacyRows(db, 'space_agent_reminders');

  return {
    copiedGoals,
    skippedGoals,
    copiedForgeScopes,
    skippedForgeScopes,
    copiedReminders,
    skippedReminders,
  };
}

function copyLegacyGoals(db: BunDatabase): number {
  return db
    .prepare(
      `INSERT OR IGNORE INTO space_long_horizon_agent_goals (
        agent_id, goal_id, relationship, created_at, updated_at
      )
      SELECT legacy.agent_id, legacy.goal_id, 'owner', legacy.created_at, legacy.created_at
      FROM space_agent_goal_assignments legacy
      JOIN space_long_horizon_agents agents
        ON agents.id = legacy.agent_id
       AND agents.space_id = legacy.space_id`
    )
    .run().changes;
}

function copyLegacyForgeScopes(db: BunDatabase): number {
  return db
    .prepare(
      `INSERT OR IGNORE INTO space_long_horizon_agent_forge_scopes (
        agent_id, scope_id, relationship, created_at, updated_at
      )
      SELECT legacy.agent_id, legacy.scope_id, 'owner', legacy.created_at, legacy.created_at
      FROM space_agent_forge_scope_assignments legacy
      JOIN space_long_horizon_agents agents
        ON agents.id = legacy.agent_id
       AND agents.space_id = legacy.space_id`
    )
    .run().changes;
}

function copyLegacyReminders(db: BunDatabase): number {
  return db
    .prepare(
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
      JOIN space_long_horizon_agents agents
        ON agents.id = legacy.agent_id
       AND agents.space_id = legacy.space_id`
    )
    .run().changes;
}

function countSkippedLegacyRows(
  db: BunDatabase,
  tableName:
    | 'space_agent_goal_assignments'
    | 'space_agent_forge_scope_assignments'
    | 'space_agent_reminders'
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM ${tableName} legacy
       LEFT JOIN space_long_horizon_agents agents
         ON agents.id = legacy.agent_id
        AND agents.space_id = legacy.space_id
       WHERE agents.id IS NULL`
    )
    .get() as { count: number };
  return row.count;
}

import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';

export interface LegacyLongHorizonMigrationReport {
  backfilledAgents: number;
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
  const backfilledAgents = backfillLegacyLongHorizonAgents(db);
  const copiedGoals = copyLegacyGoals(db);
  const skippedGoals = countSkippedLegacyRows(db, 'space_agent_goal_assignments');
  const copiedForgeScopes = copyLegacyForgeScopes(db);
  const skippedForgeScopes = countSkippedLegacyRows(db, 'space_agent_forge_scope_assignments');
  const copiedReminders = copyLegacyReminders(db);
  const skippedReminders = countSkippedLegacyRows(db, 'space_agent_reminders');

  return {
    backfilledAgents,
    copiedGoals,
    skippedGoals,
    copiedForgeScopes,
    skippedForgeScopes,
    copiedReminders,
    skippedReminders,
  };
}

function backfillLegacyLongHorizonAgents(db: BunDatabase): number {
  const now = Date.now();
  return db
    .prepare(
      `INSERT OR IGNORE INTO space_long_horizon_agents (
        id, space_id, handle, display_name, template_key, status, session_id,
        instructions, autonomy_level, model, thinking_level, provider, setting_sources,
        tool_permissions_json, created_at, updated_at
      )
      SELECT
        candidates.agent_id,
        candidates.space_id,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM space_long_horizon_agents existing
            WHERE existing.space_id = candidates.space_id
              AND existing.id != candidates.agent_id
              AND existing.status != 'archived'
              AND existing.handle = COALESCE(space_agents.handle, space_agents.name, candidates.agent_id)
          ) THEN COALESCE(space_agents.handle, space_agents.name, candidates.agent_id) || '-' || candidates.agent_id
          ELSE COALESCE(space_agents.handle, space_agents.name, candidates.agent_id)
        END,
        COALESCE(space_agents.name, space_agents.handle, candidates.agent_id),
        'migration.legacy_space_agent',
        CASE COALESCE(NULLIF(space_agents.status, ''), 'active')
          WHEN 'paused' THEN 'paused'
          WHEN 'archived' THEN 'archived'
          ELSE 'active'
        END,
        NULL,
        COALESCE(space_agents.custom_prompt, space_agents.system_prompt, ''),
        NULL,
        space_agents.model,
        space_agents.thinking_level,
        space_agents.provider,
        space_agents.setting_sources,
        CASE
          WHEN space_agents.tools IS NULL OR space_agents.tools = '' OR space_agents.tools = '[]' THEN '{}'
          ELSE json_object('tools', json(space_agents.tools))
        END,
        COALESCE(space_agents.created_at, ?),
        ?
      FROM (
        SELECT space_id, agent_id FROM space_agent_goal_assignments
        UNION
        SELECT space_id, agent_id FROM space_agent_forge_scope_assignments
        UNION
        SELECT space_id, agent_id FROM space_agent_reminders
      ) candidates
      JOIN space_agents
        ON space_agents.id = candidates.agent_id
       AND space_agents.space_id = candidates.space_id`
    )
    .run(now, now).changes;
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

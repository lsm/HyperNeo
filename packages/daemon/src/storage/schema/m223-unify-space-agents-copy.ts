import type { Database as BunDatabase } from '../sqlite-compat.ts';

const MAX_BACKFILL_PASSES = 16;

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM pragma_table_info('${tableName}') WHERE name = ?`)
    .get(columnName);
}

export function runMigration223(db: BunDatabase): void {
  if (!tableExists(db, 'space_agents') || !tableExists(db, 'space_long_horizon_agents')) return;
  addLongHorizonColumnIfMissing(db, 'description');
  addLongHorizonColumnIfMissing(db, 'model_pool');
  backfillSpaceAgentsIntoLongHorizonAgents(db);
}

function addLongHorizonColumnIfMissing(
  db: BunDatabase,
  column: 'description' | 'model_pool'
): void {
  if (tableHasColumn(db, 'space_long_horizon_agents', column)) return;
  db.exec(`ALTER TABLE space_long_horizon_agents ADD COLUMN ${column} TEXT`);
}

function backfillSpaceAgentsIntoLongHorizonAgents(db: BunDatabase): void {
  const now = Date.now();
  const depthBound = (
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM space_agents) +
                (SELECT COUNT(*) FROM space_long_horizon_agents) + 1 AS bound`
      )
      .get() as { bound: number }
  ).bound;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO space_long_horizon_agents (
      id, space_id, handle, display_name, template_key, status, session_id,
      instructions, autonomy_level, model, thinking_level, provider, setting_sources,
      tool_permissions_json, description, model_pool, created_at, updated_at
    )
    WITH RECURSIVE worker_handles (agent_id, space_id, handle, depth) AS (
      SELECT id, space_id, COALESCE(handle, name, id), 0 FROM space_agents
      UNION ALL
      SELECT worker_handles.agent_id,
             worker_handles.space_id,
             worker_handles.handle || '-' || worker_handles.agent_id,
             worker_handles.depth + 1
      FROM worker_handles
      WHERE worker_handles.depth < ?
        AND EXISTS (
          SELECT 1 FROM space_long_horizon_agents existing
          WHERE existing.space_id = worker_handles.space_id
            AND existing.id != worker_handles.agent_id
            AND existing.status != 'archived'
            AND existing.handle = worker_handles.handle
        )
    ),
    resolved_handles AS (
      SELECT worker_handles.agent_id, worker_handles.handle
      FROM worker_handles
      WHERE NOT EXISTS (
        SELECT 1 FROM worker_handles deeper
        WHERE deeper.agent_id = worker_handles.agent_id
          AND deeper.depth > worker_handles.depth
      )
    )
    SELECT
      workers.id,
      workers.space_id,
      resolved_handles.handle,
      COALESCE(workers.name, workers.handle, workers.id),
      'migration.legacy_space_agent',
      CASE COALESCE(NULLIF(workers.status, ''), 'active')
        WHEN 'paused' THEN 'paused'
        WHEN 'archived' THEN 'archived'
        ELSE 'active'
      END,
      NULL,
      COALESCE(workers.custom_prompt, workers.instructions, workers.system_prompt, ''),
      NULL,
      workers.model,
      workers.thinking_level,
      workers.provider,
      workers.setting_sources,
      CASE
        WHEN workers.tools IS NULL OR workers.tools = '' OR workers.tools = '[]' THEN '{}'
        ELSE json_object('tools', json(workers.tools))
      END,
      NULLIF(workers.description, ''),
      NULLIF(workers.model_pool, ''),
      COALESCE(workers.created_at, ?),
      ?
    FROM space_agents workers
    JOIN resolved_handles ON resolved_handles.agent_id = workers.id
    ORDER BY workers.created_at ASC, workers.id ASC
  `);
  const countUncopied = db.prepare(`
    SELECT COUNT(*) AS count
    FROM space_agents workers
    LEFT JOIN space_long_horizon_agents copied
      ON copied.id = workers.id AND copied.space_id = workers.space_id
    WHERE copied.id IS NULL
  `);
  const backfillNewColumns = db.prepare(`
    UPDATE space_long_horizon_agents SET
      description = CASE
        WHEN space_long_horizon_agents.description IS NULL
        THEN NULLIF(workers.description, '')
        ELSE space_long_horizon_agents.description
      END,
      model_pool = CASE
        WHEN space_long_horizon_agents.model_pool IS NULL
        THEN NULLIF(workers.model_pool, '')
        ELSE space_long_horizon_agents.model_pool
      END
    FROM space_agents workers
    WHERE workers.id = space_long_horizon_agents.id
      AND space_long_horizon_agents.template_key = 'migration.legacy_space_agent'
  `);

  db.exec('BEGIN');
  try {
    for (let pass = 0; pass < MAX_BACKFILL_PASSES; pass += 1) {
      if (insert.run(depthBound, now, now).changes === 0) break;
    }
    const uncopied = countUncopied.get() as { count: number };
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
        `Migration 223 left ${uncopied.count} space_agents row(s) uncopied after ` +
          `${MAX_BACKFILL_PASSES} handle-collision passes.${detail}`
      );
    }
    backfillNewColumns.run();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

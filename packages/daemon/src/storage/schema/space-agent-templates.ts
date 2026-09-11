import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function createSpaceAgentTemplatesTable(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS space_agent_templates (
      space_id TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL,
      handle TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      suggested_autonomy_level INTEGER NOT NULL DEFAULT 2
        CHECK(suggested_autonomy_level BETWEEN 1 AND 5),
      model TEXT DEFAULT NULL,
      provider TEXT DEFAULT NULL,
      model_pool TEXT DEFAULT NULL,
      thinking_level TEXT DEFAULT NULL,
      setting_sources TEXT DEFAULT NULL,
      tools TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (space_id, key)
    )
  `);
}

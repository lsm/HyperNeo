import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function runMigration243(db: BunDatabase): void {
  if (!tableExists(db, 'space_agent_templates')) return;
  if (tableHasColumn(db, 'space_agent_templates', 'space_id')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    rebuildTemplates(db);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function rebuildTemplates(db: BunDatabase): void {
  const columns = templateColumns(db);
  const carried = columns.filter((column) => column !== 'space_id');
  const list = carried.join(', ');
  db.exec(`
    CREATE TABLE space_agent_templates_m243_new (
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
      version INTEGER NOT NULL DEFAULT 1,
      labels TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (space_id, key)
    )
  `);
  db.exec(
    `INSERT INTO space_agent_templates_m243_new (${list}) SELECT ${list} FROM space_agent_templates`
  );
  db.exec(`DROP TABLE space_agent_templates`);
  db.exec(`ALTER TABLE space_agent_templates_m243_new RENAME TO space_agent_templates`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_templates_space ON space_agent_templates(space_id)`
  );
}

function templateColumns(db: BunDatabase): string[] {
  const rows = db.prepare(`PRAGMA table_info("space_agent_templates")`).all() as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
}

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all() as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === columnName);
}

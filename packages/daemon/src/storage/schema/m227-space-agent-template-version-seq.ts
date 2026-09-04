import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function runMigration227(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS space_agent_template_version_seq (
      key TEXT PRIMARY KEY,
      next_version INTEGER NOT NULL DEFAULT 1
    )
  `);

  if (!tableExists(db, 'space_agent_templates')) return;

  const rows = db.prepare(`SELECT key, version FROM space_agent_templates`).all() as Array<{
    key: string;
    version: number;
  }>;
  const update = db.prepare(
    `INSERT INTO space_agent_template_version_seq (key, next_version) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET next_version = excluded.next_version
     WHERE excluded.next_version > space_agent_template_version_seq.next_version`
  );
  for (const { key, version } of rows) {
    update.run(key, version);
  }
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
}

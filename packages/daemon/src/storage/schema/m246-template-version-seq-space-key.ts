import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function runMigration246(db: BunDatabase): void {
  if (!tableExists(db, 'space_agent_template_version_seq')) return;
  if (tableHasColumn(db, 'space_agent_template_version_seq', 'space_id')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    rebuildVersionSeq(db);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function rebuildVersionSeq(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE space_agent_template_version_seq_m246_new (
      space_id TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL,
      next_version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (space_id, key)
    )
  `);
  db.exec(
    `INSERT INTO space_agent_template_version_seq_m246_new (space_id, key, next_version)
     SELECT '', key, next_version FROM space_agent_template_version_seq`
  );
  if (tableHasColumn(db, 'space_agent_templates', 'space_id')) {
    db.exec(
      `INSERT INTO space_agent_template_version_seq_m246_new (space_id, key, next_version)
         SELECT t.space_id, t.key, MAX(t.version, COALESCE(s.next_version, 1))
           FROM space_agent_templates t
           LEFT JOIN space_agent_template_version_seq s ON s.key = t.key
       ON CONFLICT(space_id, key) DO UPDATE SET
         next_version = MAX(next_version, excluded.next_version)`
    );
  }
  db.exec(`DROP TABLE space_agent_template_version_seq`);
  db.exec(
    `ALTER TABLE space_agent_template_version_seq_m246_new RENAME TO space_agent_template_version_seq`
  );
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

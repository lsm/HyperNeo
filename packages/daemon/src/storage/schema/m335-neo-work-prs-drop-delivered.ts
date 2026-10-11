import type { Database } from '../sqlite-compat.ts';

const COLUMNS = 'work_id, prs_json, open, revision, read_at, read_ok_at';

export function runMigration335(db: Database): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'neo_work_prs' AND type = 'table'")
    .get() as { sql: string } | null;
  if (!table || !table.sql.includes('delivered')) return;
  db.exec('PRAGMA legacy_alter_table = ON');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE neo_work_prs RENAME TO neo_work_prs_drop_delivered_old');
    db.exec(`CREATE TABLE neo_work_prs (
      work_id TEXT PRIMARY KEY REFERENCES neo_work(id) ON DELETE CASCADE,
      prs_json TEXT NOT NULL,
      open INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      read_at INTEGER NOT NULL,
      read_ok_at INTEGER NOT NULL
    )`);
    db.exec(`INSERT INTO neo_work_prs (${COLUMNS})
      SELECT ${COLUMNS} FROM neo_work_prs_drop_delivered_old`);
    db.exec('DROP TABLE neo_work_prs_drop_delivered_old');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF');
  }
}

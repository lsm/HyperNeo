import type { Database } from '../sqlite-compat.ts';

const KINDS = `check_kind IN ('coding.pr_merged', 'coding.issue_filed', 'coding.issue_sub_issue',
  'coding.issue_closed', 'life-admin.confirmed')`;

export function runMigration346(db: Database): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'neo_ask_items' AND type = 'table'")
    .get() as { sql: string } | null;
  if (!table || table.sql.includes("'coding.issue_filed'")) return;
  const create = table.sql.replace(/check_kind IN \([^)]*\)/, KINDS);
  const columns = (db.prepare('PRAGMA table_info(neo_ask_items)').all() as { name: string }[])
    .map((column) => column.name)
    .join(', ');
  db.exec('PRAGMA legacy_alter_table = ON');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE neo_ask_items RENAME TO neo_ask_items_issue_checks_old');
    db.exec(create);
    db.exec(`INSERT INTO neo_ask_items (${columns})
      SELECT ${columns} FROM neo_ask_items_issue_checks_old`);
    db.exec('DROP TABLE neo_ask_items_issue_checks_old');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF');
  }
}

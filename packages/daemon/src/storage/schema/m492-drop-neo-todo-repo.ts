import type { Database } from '../sqlite-compat.ts';

export function runMigration492(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_todos)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'repo')) return;
  db.transaction(() =>
    db.exec(`CREATE TABLE IF NOT EXISTS pack_coding_todos (
        todo_id TEXT PRIMARY KEY REFERENCES neo_todos(id) ON DELETE CASCADE,
        repo TEXT
      );
      INSERT OR IGNORE INTO pack_coding_todos (todo_id, repo)
        SELECT id, repo FROM neo_todos WHERE repo IS NOT NULL;
      ALTER TABLE neo_todos DROP COLUMN repo;`)
  )();
}

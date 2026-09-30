import type { Database } from '../sqlite-compat.ts';

function hasColumns(db: Database, table: string, columns: string[]): boolean {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
  );
  return columns.every((column) => present.has(column));
}

export function runMigration292(db: Database): void {
  if (!hasColumns(db, 'sessions', ['id', 'type', 'session_context'])) return;
  db.prepare(`UPDATE sessions SET type = 'worker' WHERE type = 'space_task_agent'`).run();
}

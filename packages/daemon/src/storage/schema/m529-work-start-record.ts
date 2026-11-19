import type { Database } from '../sqlite-compat.ts';

export function runMigration529(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(work_started_sessions)').all() as {
    name: string;
  }[];
  if (!columns.length) return;
  const names = new Set(columns.map((column) => column.name));
  if (names.has('role') && !names.has('kind'))
    db.exec('ALTER TABLE work_started_sessions RENAME COLUMN role TO kind');
  for (const [name, type] of [
    ['started_by', 'TEXT'],
    ['ask_id', 'TEXT'],
    ['todo_id', 'TEXT'],
    ['machine', 'TEXT'],
    ['folder', 'TEXT'],
    ['harness', 'TEXT'],
    ['provider', 'TEXT'],
    ['model', 'TEXT'],
    ['effort', 'TEXT'],
    ['preparation', 'TEXT'],
    ['release_reason', 'TEXT'],
    ['unusable_reason', 'TEXT'],
    ['archived_at', 'INTEGER'],
    ['archive_reason', 'TEXT'],
  ]) {
    if (!names.has(name)) db.exec(`ALTER TABLE work_started_sessions ADD COLUMN ${name} ${type}`);
  }
}

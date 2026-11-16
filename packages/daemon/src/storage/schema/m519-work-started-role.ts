import type { Database } from '../sqlite-compat.ts';

// Existing rows keep no role: they cannot tell a session work.start opened
// from one that was only bound or claimed, so none of them is offered for reuse.
export function runMigration519(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(work_started_sessions)').all() as {
    name: string;
  }[];
  if (columns.length && !columns.some((column) => column.name === 'role'))
    db.exec('ALTER TABLE work_started_sessions ADD COLUMN role TEXT');
}

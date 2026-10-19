import type { Database } from '../sqlite-compat.ts';

export function runMigration404(db: Database): void {
  db.exec("DELETE FROM neo_session_bindings WHERE kind = 'project'");
}

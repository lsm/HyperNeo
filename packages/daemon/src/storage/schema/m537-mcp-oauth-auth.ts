import type { Database } from '../sqlite-compat.ts';

export function runMigration537(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(app_mcp_servers)').all() as { name: string }[];
  if (columns.length > 0 && !columns.some((column) => column.name === 'auth')) {
    db.exec('ALTER TABLE app_mcp_servers ADD COLUMN auth TEXT');
  }
}

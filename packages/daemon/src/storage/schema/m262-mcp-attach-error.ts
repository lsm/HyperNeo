import type { Database } from '../sqlite-compat.ts';

export function runMigration262(db: Database): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_mcp_servers'")
    .get();
  if (!table) return;

  const columns = db.prepare(`PRAGMA table_info(app_mcp_servers)`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'last_attach_error')) return;

  db.exec(`ALTER TABLE app_mcp_servers ADD COLUMN last_attach_error TEXT`);
}

import type { Database as BunDatabase } from '../sqlite-compat.ts';

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}

export function runMigration234(db: BunDatabase): void {
  if (!tableExists(db, 'space_agent_inbox_messages')) return;
  db.exec(`DROP TABLE space_agent_inbox_messages`);
}

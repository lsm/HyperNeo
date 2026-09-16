import type { Database } from '../sqlite-compat.ts';

const OPERATION_AUDIT_COLUMNS: Record<string, string> = {
  caller_source: 'TEXT',
  caller_role: 'TEXT',
  caller_agent_id: 'TEXT',
  outcome: 'TEXT',
  failure_code: 'TEXT',
  duration_ms: 'INTEGER',
};

export function runMigration262(db: Database): void {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mcp_audit_log'").get()
  )
    return;
  const existing = new Set(
    (db.prepare('PRAGMA table_info(mcp_audit_log)').all() as { name: string }[]).map(
      (column) => column.name
    )
  );
  for (const [column, type] of Object.entries(OPERATION_AUDIT_COLUMNS)) {
    if (!existing.has(column)) db.exec(`ALTER TABLE mcp_audit_log ADD COLUMN ${column} ${type}`);
  }
}

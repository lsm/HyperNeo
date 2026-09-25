import type { Database } from '../sqlite-compat.ts';

function tableExists(db: Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function hasColumns(db: Database, table: string, columns: string[]): boolean {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
  );
  return columns.every((column) => present.has(column));
}

const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function runMigration277(db: Database, now = new Date().toISOString()): void {
  if (
    !tableExists(db, 'space_long_horizon_agents') ||
    !hasColumns(db, 'sessions', [
      'space_id',
      'status',
      'archived_at',
      'metadata',
      'type',
      'session_context',
    ])
  ) {
    return;
  }
  const agents = new Set(
    (db.prepare(`SELECT id FROM space_long_horizon_agents`).all() as Array<{ id: string }>).map(
      (row) => row.id
    )
  );
  const rows = db
    .prepare(
      `SELECT id, metadata, session_context FROM sessions
       WHERE space_id IS NOT NULL
         AND status != 'archived'
         AND type != 'space_task_agent'
         AND id NOT LIKE '%:task:%'`
    )
    .all() as Array<{ id: string; metadata: string | null; session_context: string | null }>;
  const archive = db.prepare(
    `UPDATE sessions SET status = 'archived', archived_at = ? WHERE id = ?`
  );
  for (const row of rows) {
    const agentId = (
      parseObject(row.metadata).promptProvenance as { agentId?: unknown } | undefined
    )?.agentId;
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId) || agents.has(agentId)) continue;
    if (typeof parseObject(row.session_context).taskId === 'string') continue;
    archive.run(now, row.id);
  }
}

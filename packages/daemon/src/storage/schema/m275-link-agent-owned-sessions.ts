import type { Database } from '../sqlite-compat.ts';

function hasColumns(db: Database, table: string, columns: string[]): boolean {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
  );
  return columns.every((column) => present.has(column));
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function runMigration275(db: Database): void {
  if (
    !hasColumns(db, 'sessions', ['id', 'type', 'metadata']) ||
    !hasColumns(db, 'space_long_horizon_agents', ['id', 'handle', 'session_id', 'status'])
  ) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT s.id, s.type, s.metadata, a.id AS agent_id, a.handle
       FROM space_long_horizon_agents a JOIN sessions s ON s.id = a.session_id
       WHERE a.status != 'archived'`
    )
    .all() as Array<{
    id: string;
    type: string | null;
    metadata: string | null;
    agent_id: string;
    handle: string;
  }>;
  const update = db.prepare(`UPDATE sessions SET type = ?, metadata = ? WHERE id = ?`);
  for (const row of rows) {
    const metadata = parseObject(row.metadata);
    const provenance = metadata.promptProvenance as { agentId?: unknown } | undefined;
    if (provenance?.agentId === row.agent_id && row.type !== 'space_chat') continue;
    metadata.promptProvenance = {
      ...(provenance ?? {}),
      source: (provenance as { source?: unknown } | undefined)?.source ?? 'linked_session',
      hash: (provenance as { hash?: unknown } | undefined)?.hash ?? row.agent_id,
      agentId: row.agent_id,
      agentName: row.handle,
    };
    update.run(row.type === 'space_chat' ? 'worker' : row.type, JSON.stringify(metadata), row.id);
  }
}

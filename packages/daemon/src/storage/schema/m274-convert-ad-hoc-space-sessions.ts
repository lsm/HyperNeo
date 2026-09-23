import type { Database } from '../sqlite-compat.ts';

interface SessionRow {
  id: string;
  title: string | null;
  type: string | null;
  metadata: string | null;
  session_context: string | null;
}

function tableExists(db: Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

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

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function isAdHocSpaceSession(row: SessionRow, spaceId: string): boolean {
  if (row.id.startsWith('space:agent:')) return false;
  if (row.id.startsWith(`space:${spaceId}:`)) return false;
  if (row.id.includes(':task:') && row.id.includes(':exec:')) return false;
  const context = parseObject(row.session_context);
  if (typeof context.taskId === 'string') return false;
  const provenance = parseObject(row.metadata).promptProvenance as
    | { agentId?: unknown; workflowRunId?: unknown }
    | undefined;
  return typeof provenance?.agentId !== 'string' && typeof provenance?.workflowRunId !== 'string';
}

export function runMigration274(db: Database, now = Date.now()): void {
  if (
    !tableExists(db, 'sessions') ||
    !tableExists(db, 'spaces') ||
    !tableExists(db, 'space_long_horizon_agents') ||
    !hasColumns(db, 'sessions', ['title', 'type', 'metadata', 'session_context']) ||
    !hasColumns(db, 'space_long_horizon_agents', ['session_id'])
  ) {
    return;
  }
  const owned = new Set(
    (
      db
        .prepare(`SELECT session_id FROM space_long_horizon_agents WHERE session_id IS NOT NULL`)
        .all() as Array<{ session_id: string }>
    ).map((row) => row.session_id)
  );
  const spaceExists = db.prepare(`SELECT 1 FROM spaces WHERE id = ?`);
  const handleTaken = db.prepare(
    `SELECT 1 FROM space_long_horizon_agents WHERE space_id = ? AND handle = ? AND status != 'archived'`
  );
  const insertAgent = db.prepare(
    `INSERT INTO space_long_horizon_agents
       (id, space_id, handle, display_name, status, session_id, instructions, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, '', 'Converted from an ad-hoc Space session', ?, ?)`
  );
  const updateSession = db.prepare(`UPDATE sessions SET type = ?, metadata = ? WHERE id = ?`);
  const rows = db
    .prepare(
      `SELECT id, title, type, metadata, session_context FROM sessions
       WHERE status != 'archived' AND (type IS NULL OR type IN ('worker', 'space_chat'))`
    )
    .all() as SessionRow[];
  for (const row of rows) {
    const spaceId = parseObject(row.session_context).spaceId;
    if (typeof spaceId !== 'string' || !spaceExists.get(spaceId)) continue;
    if (owned.has(row.id) || !isAdHocSpaceSession(row, spaceId)) continue;
    const displayName = row.title?.trim() || 'Converted session';
    const base = slugify(displayName) || 'agent';
    let handle = base;
    for (let n = 2; handleTaken.get(spaceId, handle); n++) handle = `${base}-${n}`;
    const agentId = crypto.randomUUID();
    insertAgent.run(agentId, spaceId, handle, displayName, row.id, now, now);
    const metadata = parseObject(row.metadata);
    metadata.promptProvenance = {
      source: 'converted_session',
      hash: agentId,
      agentId,
      agentName: handle,
    };
    updateSession.run('worker', JSON.stringify(metadata), row.id);
    owned.add(row.id);
  }
}

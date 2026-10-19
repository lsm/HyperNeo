import type { Database } from '../sqlite-compat.ts';

const HOLDERS = "SELECT session_id FROM neo_session_bindings WHERE kind = 'project'";

const MOVES = [
  { table: 'neo_asks', column: 'session_id', live: "status = 'open'" },
  {
    table: 'legacy_neo_asks',
    column: 'origin_session_id',
    live: "status NOT IN ('achieved', 'abandoned')",
  },
  {
    table: 'neo_work',
    column: 'origin_session_id',
    live: "status IN ('proposed', 'queued', 'reported')",
  },
] as const;

const hasTable = (db: Database, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

export function runMigration393(db: Database): void {
  if (!hasTable(db, 'neo_session_bindings')) return;
  const root = db
    .prepare(
      "SELECT session_id AS sessionId FROM neo_session_bindings WHERE kind = 'neo' AND concern_id IS NULL"
    )
    .get() as { sessionId: string } | null;
  if (!root) return;
  for (const { table, column, live } of MOVES)
    if (hasTable(db, table))
      db.prepare(
        `UPDATE ${table} SET ${column} = ? WHERE ${live} AND ${column} IN (${HOLDERS})`
      ).run(root.sessionId);
}

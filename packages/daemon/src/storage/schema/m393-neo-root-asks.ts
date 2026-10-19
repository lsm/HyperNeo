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

export function runMigration393(db: Database, now = Date.now()): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_root_moves (
    source TEXT NOT NULL,
    row_id TEXT NOT NULL,
    from_session_id TEXT NOT NULL,
    moved_at INTEGER NOT NULL,
    PRIMARY KEY (source, row_id)
  )`);
  if (!hasTable(db, 'neo_session_bindings')) return;
  const root = db
    .prepare(
      "SELECT session_id AS sessionId FROM neo_session_bindings WHERE kind = 'neo' AND concern_id IS NULL"
    )
    .get() as { sessionId: string } | null;
  if (!root) return;
  for (const { table, column, live } of MOVES) {
    if (!hasTable(db, table)) continue;
    const moving = `${live} AND ${column} IN (${HOLDERS})`;
    db.prepare(
      `INSERT OR IGNORE INTO neo_root_moves (source, row_id, from_session_id, moved_at)
       SELECT '${table}', id, ${column}, ? FROM ${table} WHERE ${moving}`
    ).run(now);
    db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${moving}`).run(root.sessionId);
  }
}

export function revertMigration393(db: Database): void {
  if (!hasTable(db, 'neo_root_moves')) return;
  for (const { table, column } of MOVES)
    if (hasTable(db, table))
      db.prepare(
        `UPDATE ${table} SET ${column} = (SELECT from_session_id FROM neo_root_moves
           WHERE source = '${table}' AND row_id = ${table}.id)
         WHERE id IN (SELECT row_id FROM neo_root_moves WHERE source = '${table}')`
      ).run();
  db.exec('DELETE FROM neo_root_moves');
}

import type { Database as BunDatabase } from '../sqlite-compat.ts';

const SENTINEL = '';

export function runMigration249(db: BunDatabase): void {
  if (!tableExists(db, 'space_agent_templates')) return;
  if (!tableHasColumn(db, 'space_agent_templates', 'space_id')) return;

  const leftover = db
    .prepare(`SELECT key FROM space_agent_templates WHERE space_id = ? ORDER BY key ASC`)
    .all(SENTINEL) as Array<{ key: string }>;
  if (leftover.length === 0) return;

  const soleSpace = onlySpaceId(db);
  db.exec('BEGIN');
  try {
    if (soleSpace === null) {
      db.prepare(`DELETE FROM space_agent_templates WHERE space_id = ?`).run(SENTINEL);
    } else {
      const taken = db.prepare(
        `SELECT 1 FROM space_agent_templates WHERE space_id = ? AND key = ?`
      );
      const claim = db.prepare(
        `UPDATE space_agent_templates SET space_id = ? WHERE space_id = ? AND key = ?`
      );
      const drop = db.prepare(`DELETE FROM space_agent_templates WHERE space_id = ? AND key = ?`);
      for (const { key } of leftover) {
        if (taken.get(soleSpace, key)) drop.run(SENTINEL, key);
        else claim.run(soleSpace, SENTINEL, key);
      }
      moveCounters(db, soleSpace);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function onlySpaceId(db: BunDatabase): string | null {
  if (!tableExists(db, 'spaces')) return null;
  const rows = db.prepare(`SELECT id FROM spaces LIMIT 2`).all() as Array<{ id: string }>;
  return rows.length === 1 ? rows[0].id : null;
}

function moveCounters(db: BunDatabase, spaceId: string): void {
  if (!tableHasColumn(db, 'space_agent_template_version_seq', 'space_id')) return;
  db.prepare(
    `INSERT INTO space_agent_template_version_seq (space_id, key, next_version)
       SELECT ?, key, next_version FROM space_agent_template_version_seq WHERE space_id = ?
     ON CONFLICT(space_id, key) DO UPDATE SET
       next_version = MAX(next_version, excluded.next_version)`
  ).run(spaceId, SENTINEL);
  db.prepare(`DELETE FROM space_agent_template_version_seq WHERE space_id = ?`).run(SENTINEL);
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
}

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all() as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === columnName);
}

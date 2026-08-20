import type { Database as BunDatabase } from '../sqlite-compat';

export const SESSION_COUNTERS_TABLE_SQL = `
  -- Single-row aggregate of the sessions.list sidebar totals (total human
  -- sessions incl. archived, and archived-only). Read by sessions.list mapResult
  -- instead of two full-table COUNT(*) subqueries per evaluation. Maintained by
  -- the session_counters_* triggers below (see migration 197 for the backfill).
  CREATE TABLE IF NOT EXISTS session_counters (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total_count INTEGER NOT NULL DEFAULT 0,
    archived_count INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO session_counters (id, total_count, archived_count) VALUES (1, 0, 0);
`;

const HUMAN_SESSION_PREDICATE =
  "type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')" +
  " AND json_extract(session_context, '$.roomId') IS NULL" +
  " AND json_extract(session_context, '$.spaceId') IS NULL";

function isHuman(rowPrefix: string): string {
  return `CASE WHEN ${rowPrefix}.type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent') AND json_extract(${rowPrefix}.session_context, '$.roomId') IS NULL AND json_extract(${rowPrefix}.session_context, '$.spaceId') IS NULL THEN 1 ELSE 0 END`;
}

function isHumanArchived(rowPrefix: string): string {
  return `CASE WHEN ${rowPrefix}.type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent') AND json_extract(${rowPrefix}.session_context, '$.roomId') IS NULL AND json_extract(${rowPrefix}.session_context, '$.spaceId') IS NULL AND ${rowPrefix}.status = 'archived' THEN 1 ELSE 0 END`;
}

export function createSessionCounters(db: BunDatabase): void {
  db.exec(SESSION_COUNTERS_TABLE_SQL);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS session_counters_ai
    AFTER INSERT ON sessions BEGIN
      UPDATE session_counters SET
        total_count = total_count + ${isHuman('new')},
        archived_count = archived_count + ${isHumanArchived('new')}
      WHERE id = 1;
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS session_counters_ad
    AFTER DELETE ON sessions BEGIN
      UPDATE session_counters SET
        total_count = total_count - ${isHuman('old')},
        archived_count = archived_count - ${isHumanArchived('old')}
      WHERE id = 1;
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS session_counters_au
    AFTER UPDATE OF type, status, session_context ON sessions
    WHEN old.type IS NOT new.type
      OR old.status IS NOT new.status
      OR old.session_context IS NOT new.session_context
    BEGIN
      UPDATE session_counters SET
        total_count = total_count
          + ${isHuman('new')} - ${isHuman('old')},
        archived_count = archived_count
          + ${isHumanArchived('new')} - ${isHumanArchived('old')}
      WHERE id = 1;
    END
  `);
}

export function backfillSessionCounters(db: BunDatabase): void {
  db.exec(`
    UPDATE session_counters SET
      total_count = (SELECT COUNT(*) FROM sessions WHERE ${HUMAN_SESSION_PREDICATE}),
      archived_count = (
        SELECT COUNT(*) FROM sessions WHERE ${HUMAN_SESSION_PREDICATE} AND status = 'archived'
      )
    WHERE id = 1
  `);
}

import type { Database } from '../sqlite-compat.ts';

const ENDED =
  'Consultations ended: there is one Neo session now. Handle this ask yourself, or hand the work to a worker with work.send.';

const hasTable = (db: Database, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

export function runMigration394(db: Database): void {
  if (hasTable(db, 'neo_consultations'))
    db.prepare(
      `UPDATE neo_consultations SET status = 'failed', answer = ?,
         returned = CASE WHEN origin_session_id IN (SELECT session_id FROM neo_session_bindings
           WHERE kind = 'neo' AND concern_id IS NULL) THEN returned ELSE 1 END
       WHERE status = 'pending'`
    ).run(ENDED);
  if (hasTable(db, 'neo_consultation_waiters'))
    db.exec("UPDATE neo_consultation_waiters SET status = 'cancelled' WHERE status = 'queued'");
}

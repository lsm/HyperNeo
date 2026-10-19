import { NEO_WORK_CLOSED_DONE_PREFIX } from '@hyperneo/shared/types/neo-snapshot';
import type { Database } from '../sqlite-compat.ts';

const HOLDERS = "SELECT session_id FROM neo_session_bindings WHERE kind = 'project'";
const CLOSED = 'Closed when Neo became one session.';
const CLOSED_DONE = `${NEO_WORK_CLOSED_DONE_PREFIX}the move to one Neo session.`;

const hasTable = (db: Database, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

export function runMigration395(db: Database, now = Date.now()): void {
  if (!hasTable(db, 'neo_session_bindings')) return;
  if (hasTable(db, 'job_queue'))
    db.prepare(
      `UPDATE job_queue SET status = 'dead', error = ?, completed_at = ?
       WHERE status IN ('pending', 'processing')
         AND ((queue = 'mailbox' AND json_extract(payload, '$.to.sessionId') IN (${HOLDERS}))
           OR (queue = 'message_delivery' AND json_extract(payload, '$.sessionId') IN (${HOLDERS})))`
    ).run(CLOSED, now);
  if (hasTable(db, 'sdk_messages'))
    db.exec(`UPDATE sdk_messages SET send_status = 'failed'
      WHERE send_status IN ('deferred', 'enqueued') AND session_id IN (${HOLDERS})`);
  if (hasTable(db, 'legacy_neo_asks'))
    db.prepare(
      `UPDATE legacy_neo_asks SET status = 'abandoned', outcome = ?, settled_at = ?, updated_at = ?
       WHERE status NOT IN ('achieved', 'abandoned')`
    ).run(CLOSED, now, now);
  if (hasTable(db, 'neo_work')) {
    db.exec(
      "UPDATE neo_work SET status = 'cancelled' WHERE status IN ('proposed', 'queued', 'failed')"
    );
    db.prepare(
      `UPDATE neo_work SET report = ? || COALESCE(char(10) || char(10) || report, '')
       WHERE status = 'reported' AND substr(COALESCE(report, ''), 1, ?) != ?`
    ).run(CLOSED_DONE, NEO_WORK_CLOSED_DONE_PREFIX.length, NEO_WORK_CLOSED_DONE_PREFIX);
  }
  if (hasTable(db, 'sessions'))
    db.prepare(
      `UPDATE sessions SET status = 'archived', archived_at = ?
       WHERE status != 'archived' AND id IN (${HOLDERS})`
    ).run(new Date(now).toISOString());
}

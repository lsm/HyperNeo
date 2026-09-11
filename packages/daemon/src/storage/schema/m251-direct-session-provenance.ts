import type { Database } from '../sqlite-compat.ts';

export function runMigration251(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS direct_task_session_provenance (
      session_id TEXT PRIMARY KEY
    );
    INSERT INTO direct_task_session_provenance(session_id)
      SELECT session_id FROM direct_task_execution_attempts WHERE TRUE
      ON CONFLICT(session_id) DO NOTHING;
    CREATE TRIGGER IF NOT EXISTS direct_task_session_no_reuse
      BEFORE INSERT ON direct_task_execution_attempts
      WHEN EXISTS (SELECT 1 FROM direct_task_session_provenance WHERE session_id = NEW.session_id)
      BEGIN SELECT RAISE(IGNORE); END;
    CREATE TRIGGER IF NOT EXISTS direct_task_session_record_provenance
      AFTER INSERT ON direct_task_execution_attempts
      BEGIN
        INSERT INTO direct_task_session_provenance(session_id) VALUES(NEW.session_id);
      END;
    CREATE TRIGGER IF NOT EXISTS direct_task_session_identity_immutable
      BEFORE UPDATE OF session_id ON direct_task_execution_attempts
      WHEN NEW.session_id <> OLD.session_id
      BEGIN SELECT RAISE(ABORT, 'Direct attempt session identity is immutable'); END;
  `);
}

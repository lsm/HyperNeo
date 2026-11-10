import type { Database } from '../sqlite-compat.ts';

export function runMigration498(db: Database): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_external_events_source_topic_lower
    ON session_external_events(source, lower(topic))`);
}

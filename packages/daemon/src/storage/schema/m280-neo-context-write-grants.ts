import type { Database } from '../sqlite-compat.ts';

export function runMigration280(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_context_write_grants (
    consultation_id TEXT PRIMARY KEY REFERENCES neo_consultations(id) ON DELETE CASCADE,
    context_revision INTEGER NOT NULL CHECK (context_revision > 0)
  )`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS neo_consultation_capture_context_revision
    AFTER INSERT ON neo_consultations
    WHEN NEW.status = 'pending'
    BEGIN
      INSERT INTO neo_context_write_grants (consultation_id, context_revision)
      SELECT NEW.id, revision FROM neo_concerns WHERE id = NEW.concern_id;
    END`);
}

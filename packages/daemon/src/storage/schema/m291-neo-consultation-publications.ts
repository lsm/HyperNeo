import type { Database } from '../sqlite-compat.ts';

export function createNeoConsultationPublicationTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_consultation_publications (
    consultation_id TEXT PRIMARY KEY REFERENCES neo_consultations(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    answer TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(conversation_id, publication_id)
      REFERENCES neo_publications(conversation_id, publication_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_neo_consultation_publications_publication
    ON neo_consultation_publications(conversation_id, publication_id)`);
}

export function runMigration291(db: Database): void {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_consultations' AND type = 'table'")
      .get() ||
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_publications' AND type = 'table'")
      .get()
  )
    return;
  createNeoConsultationPublicationTable(db);
}

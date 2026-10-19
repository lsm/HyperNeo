import type { Database } from '../sqlite-compat.ts';

export function runMigration361(db: Database): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'neo_session_bindings'")
    .get() as { sql: string } | null;
  if (table?.sql.includes("'concern'")) {
    db.transaction(() => {
      db.exec(`CREATE TABLE neo_project_bindings_migration (
        session_id TEXT PRIMARY KEY,
        concern_id TEXT REFERENCES neo_concerns(id),
        kind TEXT NOT NULL CHECK (kind IN ('neo', 'project', 'worker')),
        CHECK (kind = 'worker' OR (kind = 'neo' AND concern_id IS NULL)
          OR (kind = 'project' AND concern_id IS NOT NULL))
      );
      INSERT INTO neo_project_bindings_migration SELECT session_id, concern_id,
        CASE kind WHEN 'concern' THEN 'project' ELSE kind END FROM neo_session_bindings;
      DROP TABLE neo_session_bindings;
      ALTER TABLE neo_project_bindings_migration RENAME TO neo_session_bindings;
      CREATE UNIQUE INDEX idx_neo_session_bindings_coordinator
        ON neo_session_bindings(COALESCE(concern_id, '')) WHERE kind IN ('neo', 'project');`);
    })();
  }
  db.exec(`CREATE TABLE IF NOT EXISTS neo_project_workspaces (
    alias TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES neo_concerns(id)
  )`);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_consultation_publications'").get())
    db.exec(`UPDATE neo_consultation_publications SET payload_json = replace(payload_json, '"kind":"concern"', '"kind":"project"')
    WHERE payload_json LIKE '%"kind":"concern"%'`);
  db.exec(`UPDATE neo_publications SET payload_json = replace(payload_json, '"kind":"concern"', '"kind":"project"')
    WHERE payload_json LIKE '%"kind":"concern"%'`);
}

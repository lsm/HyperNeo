import type { Database } from '../sqlite-compat.ts';

export function createSessionIncarnationTable(db: Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS session_incarnations (
      incarnation INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE
    );
    CREATE TRIGGER IF NOT EXISTS sessions_incarnation_insert AFTER INSERT ON sessions
    BEGIN
      INSERT OR REPLACE INTO session_incarnations(session_id) VALUES (NEW.id);
    END;
    CREATE TRIGGER IF NOT EXISTS sessions_incarnation_delete AFTER DELETE ON sessions
    BEGIN
      DELETE FROM session_incarnations WHERE session_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS sessions_incarnation_rekey AFTER UPDATE OF id ON sessions
    WHEN NEW.id IS NOT OLD.id
    BEGIN
      DELETE FROM session_incarnations WHERE session_id = OLD.id;
      INSERT OR REPLACE INTO session_incarnations(session_id) VALUES (NEW.id);
    END;
    CREATE TRIGGER IF NOT EXISTS sessions_incarnation_revive AFTER UPDATE OF status ON sessions
    WHEN OLD.status = 'archived' AND NEW.status IS NOT 'archived'
    BEGIN
      INSERT OR REPLACE INTO session_incarnations(session_id) VALUES (NEW.id);
    END;
    INSERT INTO session_incarnations(session_id)
      SELECT id FROM sessions s
      WHERE NOT EXISTS (SELECT 1 FROM session_incarnations i WHERE i.session_id = s.id);`);
  })();
}

export function runMigration290(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sessions' AND type = 'table'").get())
    return;
  createSessionIncarnationTable(db);
}

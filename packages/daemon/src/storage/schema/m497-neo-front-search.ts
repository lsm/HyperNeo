import type { Database } from '../sqlite-compat.ts';

export function runMigration497(db: Database): void {
  db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='neo_front_project_fts'").get()) {
      db.exec(`CREATE VIRTUAL TABLE neo_front_project_fts USING fts5(
        title, content='neo_concerns', content_rowid='rowid', detail=full, tokenize='trigram');
      CREATE TRIGGER neo_front_project_fts_ai AFTER INSERT ON neo_concerns BEGIN
        INSERT INTO neo_front_project_fts(rowid,title) VALUES (new.rowid,new.title);
      END;
      CREATE TRIGGER neo_front_project_fts_ad AFTER DELETE ON neo_concerns BEGIN
        INSERT INTO neo_front_project_fts(neo_front_project_fts,rowid,title)
          VALUES ('delete',old.rowid,old.title);
      END;
      CREATE TRIGGER neo_front_project_fts_au AFTER UPDATE OF title ON neo_concerns
        WHEN old.title IS NOT new.title BEGIN
        INSERT INTO neo_front_project_fts(neo_front_project_fts,rowid,title)
          VALUES ('delete',old.rowid,old.title);
        INSERT INTO neo_front_project_fts(rowid,title) VALUES (new.rowid,new.title);
      END;
      INSERT INTO neo_front_project_fts(neo_front_project_fts) VALUES ('rebuild');`);
    }
    for (const table of ['neo_concerns', 'neo_asks', 'neo_questions', 'neo_todos']) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_front_${table}_created ON ${table}(created_at DESC,id DESC)`
        );
    }
  })();
}

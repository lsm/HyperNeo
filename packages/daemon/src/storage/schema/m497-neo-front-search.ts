import type { Database } from '../sqlite-compat.ts';

export function runMigration497(db: Database): void {
  db.transaction(() => {
    for (const [fts, table, key] of [
      ['neo_front_project_fts', 'neo_concerns', 'rowid'],
      ['neo_front_card_fts', 'neo_card_search_content', 'id'],
    ]) {
      if (
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) &&
        !db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(fts)
      ) {
        db.exec(`CREATE VIRTUAL TABLE ${fts} USING fts5(
          title, content='${table}', content_rowid='${key}', detail=column, tokenize='unicode61');
        CREATE TRIGGER ${fts}_ai AFTER INSERT ON ${table} BEGIN
          INSERT INTO ${fts}(rowid,title) VALUES (new.${key},new.title);
        END;
        CREATE TRIGGER ${fts}_ad AFTER DELETE ON ${table} BEGIN
          INSERT INTO ${fts}(${fts},rowid,title) VALUES ('delete',old.${key},old.title);
        END;
        CREATE TRIGGER ${fts}_au AFTER UPDATE OF title ON ${table}
          WHEN old.title IS NOT new.title BEGIN
          INSERT INTO ${fts}(${fts},rowid,title) VALUES ('delete',old.${key},old.title);
          INSERT INTO ${fts}(rowid,title) VALUES (new.${key},new.title);
        END;
        INSERT INTO ${fts}(${fts}) VALUES ('rebuild');`);
      }
    }
    for (const [table, condition] of [
      ['neo_asks', "status='open'"],
      ['neo_questions', "state='open'"],
      ['neo_todos', "state NOT IN ('done','removed')"],
    ]) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_front_${table}_active ON ${table}(id) WHERE ${condition}`
        );
    }
  })();
}

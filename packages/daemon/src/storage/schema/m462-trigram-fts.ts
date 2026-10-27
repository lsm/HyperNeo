import type { Database } from '../sqlite-compat.ts';

const hasTable = (db: Database, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

function rebuildTrigram(
  db: Database,
  table: string,
  columns: readonly string[],
  content: string,
  contentRowid: string
): void {
  const shadowTables = [
    table,
    ...['_data', '_idx', '_content', '_docsize', '_config'].map((suffix) => `${table}${suffix}`),
  ];
  for (const shadow of shadowTables) db.exec(`DROP TABLE IF EXISTS ${shadow}`);
  db.exec(`CREATE VIRTUAL TABLE ${table} USING fts5(
      ${columns.join(', ')},
      content = '${content}',
      content_rowid = '${contentRowid}',
      detail = 'full',
      tokenize = 'trigram'
    )`);
  db.exec(`INSERT INTO ${table}(${table}) VALUES('rebuild')`);
}

export function runMigration462(db: Database): void {
  db.transaction(() => {
    if (hasTable(db, 'message_search_content')) {
      rebuildTrigram(db, 'message_search_fts', ['title', 'body'], 'message_search_content', 'id');
    }
    if (hasTable(db, 'neo_card_search_content')) {
      rebuildTrigram(
        db,
        'neo_card_search_fts',
        ['title', 'meta', 'body'],
        'neo_card_search_content',
        'id'
      );
    }
  })();
}

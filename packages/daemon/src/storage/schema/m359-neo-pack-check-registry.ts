import type { Database } from '../sqlite-compat.ts';

export function runMigration359(db: Database): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'neo_ask_items'")
    .get() as { sql: string } | null;
  if (!table) return;
  const sql = table.sql.replace(/CHECK\s*\(\s*check_kind\s+IN\s*\([^)]*\)\s*\)/i, '');
  if (sql === table.sql) return;
  const objects = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE tbl_name = 'neo_ask_items' AND type IN ('index', 'trigger') AND sql IS NOT NULL"
    )
    .all() as { sql: string }[];
  const columns = (db.prepare('PRAGMA table_info(neo_ask_items)').all() as { name: string }[])
    .map(({ name }) => `"${name.replaceAll('"', '""')}"`)
    .join(', ');
  const foreignKeys = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number })
    .foreign_keys;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(sql.replace('neo_ask_items', 'neo_ask_items_registry_new'));
      db.exec(
        `INSERT INTO neo_ask_items_registry_new (${columns}) SELECT ${columns} FROM neo_ask_items`
      );
      db.exec('DROP TABLE neo_ask_items');
      db.exec('ALTER TABLE neo_ask_items_registry_new RENAME TO neo_ask_items');
      for (const object of objects) db.exec(object.sql);
      if (db.prepare('PRAGMA foreign_key_check').all().length)
        throw new Error('neo_pack_check_registry_foreign_key_violation');
    })();
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

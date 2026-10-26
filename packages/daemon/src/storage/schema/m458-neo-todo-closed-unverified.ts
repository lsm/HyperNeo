import type { Database } from '../sqlite-compat.ts';

const STATES =
  /CHECK\s*\(\s*state\s+IN\s*\(\s*'todo',\s*'doing',\s*'blocked',\s*'done',\s*'failed',\s*'removed'\s*\)\s*\)/i;

export function runMigration458(db: Database): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'neo_todos'")
    .get() as { sql: string } | null;
  if (!table || !STATES.test(table.sql)) return;
  const sql = table.sql.replace(
    STATES,
    "CHECK (state IN ('todo', 'doing', 'blocked', 'closed_unverified', 'done', 'failed', 'removed'))"
  );
  const objects = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE tbl_name = 'neo_todos' AND type IN ('index', 'trigger') AND sql IS NOT NULL"
    )
    .all() as { sql: string }[];
  const columns = (db.prepare('PRAGMA table_info(neo_todos)').all() as { name: string }[])
    .map(({ name }) => `"${name.replaceAll('"', '""')}"`)
    .join(', ');
  const foreignKeys = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number })
    .foreign_keys;
  const references = db
    .prepare(
      `SELECT DISTINCT m.name FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
       WHERE m.type = 'table' AND f."table" = 'neo_todos'`
    )
    .all() as { name: string }[];
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(sql.replace(/neo_todos/, 'neo_todos_unverified_new'));
      db.exec(`INSERT INTO neo_todos_unverified_new (${columns}) SELECT ${columns} FROM neo_todos`);
      db.exec('DROP TABLE neo_todos');
      db.exec('ALTER TABLE neo_todos_unverified_new RENAME TO neo_todos');
      for (const object of objects) db.exec(object.sql);
      for (const name of new Set(['neo_todos', ...references.map((row) => row.name)])) {
        const violations = db
          .prepare('SELECT parent FROM pragma_foreign_key_check(?)')
          .all(name) as { parent: string }[];
        if (violations.some(({ parent }) => name === 'neo_todos' || parent === 'neo_todos'))
          throw new Error('neo_todo_unverified_foreign_key_violation');
      }
    })();
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

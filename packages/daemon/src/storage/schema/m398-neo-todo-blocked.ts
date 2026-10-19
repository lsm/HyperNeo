import type { Database } from '../sqlite-compat.ts';

const STATES =
  /CHECK\s*\(\s*state\s+IN\s*\(\s*'todo',\s*'doing',\s*'done',\s*'failed',\s*'removed'\s*\)\s*\)/i;
const COLUMNS = ['blocked_reason', 'next_action', 'blocked_by'];

function allowBlocked(db: Database): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'neo_todos'")
    .get() as { sql: string } | null;
  if (!table || !STATES.test(table.sql)) return;
  const sql = table.sql.replace(
    STATES,
    "CHECK (state IN ('todo', 'doing', 'blocked', 'done', 'failed', 'removed'))"
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
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(sql.replace(/neo_todos/, 'neo_todos_blocked_new'));
      db.exec(`INSERT INTO neo_todos_blocked_new (${columns}) SELECT ${columns} FROM neo_todos`);
      db.exec('DROP TABLE neo_todos');
      db.exec('ALTER TABLE neo_todos_blocked_new RENAME TO neo_todos');
      for (const object of objects) db.exec(object.sql);
      if ((db.prepare('SELECT 1 FROM pragma_foreign_key_check').all() as unknown[]).length)
        throw new Error('neo_todo_blocked_foreign_key_violation');
    })();
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

export function runMigration398(db: Database): void {
  allowBlocked(db);
  const existing = new Set(
    (db.prepare('PRAGMA table_info(neo_todos)').all() as { name: string }[]).map(({ name }) => name)
  );
  if (!existing.size) return;
  for (const column of COLUMNS)
    if (!existing.has(column)) db.exec(`ALTER TABLE neo_todos ADD COLUMN ${column} TEXT`);
}

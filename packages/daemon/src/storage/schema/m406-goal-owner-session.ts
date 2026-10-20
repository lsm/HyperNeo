import type { Database } from '../sqlite-compat.ts';

const GOAL_COLUMNS = [
  'owner_session_id TEXT',
  'done_test TEXT',
  'mandate_ref TEXT',
  'mandate_rev TEXT',
  'works_note TEXT',
  'works_note_through INTEGER',
  'facts_lines TEXT',
];
const SPACE_REQUIRED = /space_id\s+TEXT\s+NOT\s+NULL/i;
const EVENT_TYPES = /'schedule_updated'\s*\)/i;
const EVENT_SOURCES = /'system'\s*\)/i;

function tableSql(db: Database, table: string): string | null {
  return (
    (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as {
        sql: string;
      } | null
    )?.sql ?? null
  );
}

function rebuild(db: Database, table: string, sql: string): void {
  const objects = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL"
    )
    .all(table) as { sql: string }[];
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map(({ name }) => `"${name.replaceAll('"', '""')}"`)
    .join(', ');
  const references = db
    .prepare(
      `SELECT DISTINCT m.name FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
       WHERE m.type = 'table' AND f."table" = ?`
    )
    .all(table) as { name: string }[];
  const next = `${table}_m406`;
  db.transaction(() => {
    db.exec(sql.replace(table, next));
    db.exec(`INSERT INTO ${next} (${columns}) SELECT ${columns} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${next} RENAME TO ${table}`);
    for (const object of objects) db.exec(object.sql);
    for (const name of new Set([table, ...references.map((row) => row.name)])) {
      const violations = db.prepare('SELECT parent FROM pragma_foreign_key_check(?)').all(name) as {
        parent: string;
      }[];
      if (violations.some(({ parent }) => name === table || parent === table))
        throw new Error(`m406_foreign_key_violation: ${name}`);
    }
  })();
}

export function runMigration406(db: Database): void {
  const goals = tableSql(db, 'space_goals');
  const events = tableSql(db, 'space_goal_events');
  if (!goals || !events) return;
  const existing = new Set(
    (db.prepare('PRAGMA table_info(space_goals)').all() as { name: string }[]).map(
      ({ name }) => name
    )
  );
  for (const column of GOAL_COLUMNS)
    if (!existing.has(column.split(' ')[0]))
      db.exec(`ALTER TABLE space_goals ADD COLUMN ${column}`);
  const foreignKeys = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number })
    .foreign_keys;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    if (SPACE_REQUIRED.test(goals))
      rebuild(
        db,
        'space_goals',
        tableSql(db, 'space_goals')!
          .replace(SPACE_REQUIRED, 'space_id TEXT')
          .replace(/\)\s*$/, ',\n  CHECK ((space_id IS NULL) <> (owner_session_id IS NULL))\n)')
      );
    if (!events.includes('journal_compacted'))
      rebuild(
        db,
        'space_goal_events',
        events
          .replace(SPACE_REQUIRED, 'space_id TEXT')
          .replace(EVENT_TYPES, "'schedule_updated', 'journal_compacted')")
          .replace(EVENT_SOURCES, "'system', 'neo', 'human')")
      );
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

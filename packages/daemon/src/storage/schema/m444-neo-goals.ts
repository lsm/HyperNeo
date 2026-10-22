import type { Database } from '../sqlite-compat.ts';

export function createNeoGoalsTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_goals (
    id TEXT PRIMARY KEY,
    owner_session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'archived')),
    type TEXT NOT NULL DEFAULT 'one_shot' CHECK(type IN ('one_shot', 'measurable', 'recurring')),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
    metrics TEXT NOT NULL DEFAULT '{}',
    done_test TEXT,
    summary TEXT NOT NULL DEFAULT '',
    works_note TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    next_steps TEXT NOT NULL DEFAULT '[]',
    mandate_ref TEXT,
    mandate_rev TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 0,
    facts_lines TEXT,
    works_note_through INTEGER,
    wake_schedule TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_neo_goals_owner ON neo_goals(owner_session_id, status, updated_at)`);
}

function tableSql(db: Database, table: string): string {
  return (
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {
      sql: string;
    }
  ).sql;
}

function rebuild(db: Database, table: string, sql: string): void {
  const objects = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL"
    )
    .all(table) as { sql: string }[];
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map(({ name }) => `"${name.replaceAll('"', '""')}"`)
    .join(', ');
  const next = `${table}_m444`;
  db.exec(sql.replace(table, next));
  db.exec(`INSERT INTO ${next}(rowid, ${columns}) SELECT rowid, ${columns} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${next} RENAME TO ${table}`);
  for (const object of objects) db.exec(object.sql);
}

export function runMigration444(db: Database): void {
  const goals = tableSql(db, 'space_goals');
  const journal = tableSql(db, 'goal_journal');
  const asks = tableSql(db, 'neo_asks');
  const legacy = /REFERENCES\s+space_goals/i;
  if (db.prepare('SELECT 1 FROM space_goals WHERE space_id IS NULL LIMIT 1').get())
    throw new Error(
      'm444_legacy_session_goals: preserve existing goals; migration requires explicit reconciliation'
    );
  if (legacy.test(journal) && db.prepare('SELECT 1 FROM goal_journal LIMIT 1').get())
    throw new Error(
      'm444_legacy_goal_journal: preserve existing journal; migration requires explicit reconciliation'
    );
  const foreignKeys = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number })
    .foreign_keys;
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.transaction(() => {
      createNeoGoalsTable(db);
      if (legacy.test(journal))
        rebuild(db, 'goal_journal', journal.replace(legacy, 'REFERENCES neo_goals'));
      if (legacy.test(asks)) rebuild(db, 'neo_asks', asks.replace(legacy, 'REFERENCES neo_goals'));
      if (!/space_id\s+TEXT\s+NOT\s+NULL/i.test(goals))
        rebuild(
          db,
          'space_goals',
          goals
            .replace(/space_id\s+TEXT/i, 'space_id TEXT NOT NULL')
            .replace(/,\s*CHECK\s*\(\(space_id IS NULL\) <> \(owner_session_id IS NULL\)\)/i, '')
        );
      for (const table of [
        'neo_goals',
        'neo_asks',
        'goal_journal',
        'space_goals',
        'space_goal_events',
      ])
        if (db.prepare('SELECT 1 FROM pragma_foreign_key_check(?) LIMIT 1').get(table))
          throw new Error(`m444_foreign_key_violation: ${table}`);
    })();
  } finally {
    db.exec(`PRAGMA foreign_keys=${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

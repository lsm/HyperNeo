import type { Database } from '../sqlite-compat.ts';

const hasTable = (db: Database, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

const NEW_TABLES = ['pack_facts', 'neo_questions', 'neo_todo_sessions', 'neo_todos', 'neo_asks'];

function renameTable(db: Database, from: string, to: string): void {
  const legacy = (db.prepare('PRAGMA legacy_alter_table').get() as { legacy_alter_table: number })
    .legacy_alter_table;
  db.exec('PRAGMA legacy_alter_table = OFF');
  try {
    db.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
  } finally {
    db.exec(`PRAGMA legacy_alter_table = ${legacy ? 'ON' : 'OFF'}`);
  }
}

export function runMigration387(db: Database): void {
  if (hasTable(db, 'neo_asks') && !hasTable(db, 'legacy_neo_asks'))
    renameTable(db, 'neo_asks', 'legacy_neo_asks');
  db.exec(`CREATE TABLE IF NOT EXISTS neo_asks (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES neo_concerns(id),
    session_id TEXT NOT NULL,
    origin_message_id TEXT,
    title TEXT NOT NULL,
    request TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
    outcome TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    settled_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_neo_asks_project ON neo_asks(project_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_neo_asks_session ON neo_asks(session_id, status);
  CREATE TABLE IF NOT EXISTS neo_todos (
    id TEXT PRIMARY KEY,
    ask_id TEXT NOT NULL REFERENCES neo_asks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    title TEXT NOT NULL,
    done_when TEXT NOT NULL,
    check_json TEXT CHECK (check_json IS NULL OR json_valid(check_json)),
    instruction TEXT,
    named TEXT CHECK (named IS NULL OR json_valid(named)),
    state TEXT NOT NULL DEFAULT 'todo'
      CHECK (state IN ('todo', 'doing', 'done', 'failed', 'removed')),
    reason TEXT,
    replaced_by TEXT REFERENCES neo_todos(id),
    added_after_start INTEGER NOT NULL DEFAULT 0,
    report TEXT,
    evidence TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_neo_todos_ask ON neo_todos(ask_id, position);
  CREATE TABLE IF NOT EXISTS neo_todo_sessions (
    todo_id TEXT PRIMARY KEY REFERENCES neo_todos(id) ON DELETE CASCADE,
    target TEXT NOT NULL CHECK (json_valid(target)),
    ref TEXT CHECK (ref IS NULL OR json_valid(ref)),
    started_at INTEGER,
    needs_you_since INTEGER,
    live_status TEXT,
    link TEXT,
    remote_link TEXT,
    input_before INTEGER,
    sent_opening TEXT,
    sent_receipt TEXT,
    retries INTEGER NOT NULL DEFAULT 0,
    follow_anchor INTEGER,
    start_interrupted INTEGER NOT NULL DEFAULT 0,
    checked_at INTEGER,
    unchecked INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER,
    actual_model TEXT,
    actual_effort TEXT
  );
  CREATE TABLE IF NOT EXISTS neo_questions (
    id TEXT PRIMARY KEY,
    ask_id TEXT NOT NULL REFERENCES neo_asks(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('yesno', 'choice', 'reply', 'start')),
    options TEXT CHECK (options IS NULL OR json_valid(options)),
    multiple INTEGER NOT NULL DEFAULT 0,
    no_label TEXT,
    yes_label TEXT,
    start_todos TEXT CHECK (start_todos IS NULL OR json_valid(start_todos)),
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'answered', 'retired')),
    answer TEXT CHECK (answer IS NULL OR json_valid(answer)),
    answered_by TEXT CHECK (answered_by IS NULL OR answered_by IN ('button', 'chat')),
    answered_at INTEGER,
    retired_reason TEXT,
    replaced_by TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_neo_questions_ask ON neo_questions(ask_id, state);
  CREATE TABLE IF NOT EXISTS pack_facts (
    todo_id TEXT NOT NULL REFERENCES neo_todos(id) ON DELETE CASCADE,
    pack TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    PRIMARY KEY(todo_id, pack, key)
  )`);
}

export function revertMigration387(db: Database): 'restored' | 'nothing' | 'has_rows' {
  if (!hasTable(db, 'legacy_neo_asks')) return 'nothing';
  if (
    NEW_TABLES.some(
      (table) => hasTable(db, table) && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()
    )
  )
    return 'has_rows';
  for (const table of NEW_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
  db.exec("DELETE FROM migration_markers WHERE key = 'migration_387'");
  renameTable(db, 'legacy_neo_asks', 'neo_asks');
  return 'restored';
}

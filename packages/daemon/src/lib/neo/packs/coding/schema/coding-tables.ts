import type { Database } from '../../../../../storage/sqlite-compat.ts';

export function prepareCodingTodoStorage(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pack_coding_todos (
    todo_id TEXT PRIMARY KEY REFERENCES neo_todos(id) ON DELETE CASCADE,
    repo TEXT
  );`);
}

export function createCodingPackTables(db: Database, activatedAt = Date.now()): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pack_coding_daemon_merges (
    url TEXT NOT NULL, head TEXT NOT NULL, actor TEXT NOT NULL,
    started_at INTEGER NOT NULL, merge_commit TEXT, merged_at INTEGER, notified_at INTEGER,
    PRIMARY KEY (url, head)
  );
  CREATE TABLE IF NOT EXISTS pack_coding_daemon_merge_retries (
    url TEXT NOT NULL, head TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (url, head)
  );
  CREATE TABLE IF NOT EXISTS pack_coding_daemon_merge_failures (
    url TEXT NOT NULL, head TEXT NOT NULL, actor TEXT NOT NULL,
    started_at INTEGER NOT NULL, error TEXT NOT NULL, confirmed_open INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (url, head, started_at)
  );
  DROP TABLE IF EXISTS pack_coding_daemon_merge_notices;
  CREATE TABLE IF NOT EXISTS pack_coding_delivery_facts (
    todo_id TEXT NOT NULL REFERENCES neo_todos(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    head TEXT NOT NULL,
    gate_json TEXT NOT NULL CHECK (json_valid(gate_json)),
    smoke_json TEXT CHECK (smoke_json IS NULL OR json_valid(smoke_json)),
    PRIMARY KEY (todo_id, url, head)
  );
  CREATE TABLE IF NOT EXISTS pack_coding_todo_prs (
    todo_id TEXT PRIMARY KEY REFERENCES neo_todos(id) ON DELETE CASCADE,
    prs_json TEXT NOT NULL CHECK (json_valid(prs_json)),
    read_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pack_coding_stage_heads (
    url TEXT PRIMARY KEY,
    observed_at INTEGER NOT NULL,
    head TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pack_coding_stage_facts (
    url TEXT NOT NULL,
    head TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('review', 'qa')),
    fact_json TEXT NOT NULL CHECK (json_valid(fact_json)),
    PRIMARY KEY (url, stage)
  );
  CREATE TABLE IF NOT EXISTS pack_coding_pr_ledger (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    branch TEXT NOT NULL,
    head TEXT NOT NULL,
    state TEXT NOT NULL,
    state_since INTEGER NOT NULL,
    closed_at INTEGER,
    owner TEXT CHECK (owner IS NULL OR json_valid(owner)),
    nudges INTEGER NOT NULL DEFAULT 0,
    told_at INTEGER,
    read_at INTEGER NOT NULL,
    PRIMARY KEY (repo, number)
  );
  CREATE TABLE IF NOT EXISTS pack_coding_pr_event_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    activated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pack_coding_poll_facts (
    http_json TEXT CHECK (http_json IS NULL OR json_valid(http_json)),
    subject TEXT PRIMARY KEY CHECK (json_valid(subject)),
    fact_revision INTEGER NOT NULL,
    observation_revision INTEGER NOT NULL,
    value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
    etag TEXT,
    next_url TEXT,
    observed_at INTEGER,
    attempted_at INTEGER NOT NULL,
    reason TEXT CHECK (reason IS NULL OR reason IN ('failed','partial','rate_limited','not_authorized'))
  );
  CREATE INDEX IF NOT EXISTS idx_pack_coding_poll_facts_attempted ON pack_coding_poll_facts(attempted_at);
  CREATE TABLE IF NOT EXISTS pack_coding_query_facts (
    subject TEXT PRIMARY KEY CHECK (json_valid(subject)),
    coverage_json TEXT NOT NULL CHECK (json_valid(coverage_json)),
    fact_revision INTEGER NOT NULL,
    observation_revision INTEGER NOT NULL,
    value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
    observed_at INTEGER,
    attempted_at INTEGER NOT NULL,
    reason TEXT CHECK (reason IS NULL OR reason = 'failed')
  );
  CREATE TABLE IF NOT EXISTS pack_coding_ref_facts (
    subject TEXT PRIMARY KEY CHECK (json_valid(subject)),
    fact_revision INTEGER NOT NULL,
    observation_revision INTEGER NOT NULL,
    value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
    observed_at INTEGER,
    attempted_at INTEGER NOT NULL,
    reason TEXT CHECK (reason IS NULL OR reason = 'failed')
  );
  CREATE TABLE IF NOT EXISTS pack_coding_work_facts (
    url TEXT PRIMARY KEY,
    fact_revision INTEGER NOT NULL,
    observation_revision INTEGER NOT NULL,
    value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
    observed_at INTEGER,
    attempted_at INTEGER NOT NULL,
    reason TEXT CHECK (reason IS NULL OR reason = 'failed')
  );
  CREATE TABLE IF NOT EXISTS pack_coding_branch_facts (
    coverage_limit INTEGER NOT NULL,
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    fact_revision INTEGER NOT NULL,
    observation_revision INTEGER NOT NULL,
    urls_json TEXT CHECK (urls_json IS NULL OR json_valid(urls_json)),
    observed_at INTEGER,
    attempted_at INTEGER NOT NULL,
    retry_at INTEGER NOT NULL,
    reason TEXT CHECK (reason IS NULL OR reason IN ('failed', 'partial', 'rate_limited', 'not_authorized')),
    PRIMARY KEY (repo, branch)
  );
  CREATE TABLE IF NOT EXISTS pack_coding_merge_facts (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    fact_revision INTEGER NOT NULL,
    observation_revision INTEGER NOT NULL,
    value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
    source TEXT,
    observed_at INTEGER,
    attempted_at INTEGER NOT NULL,
    reason TEXT CHECK (reason IS NULL OR reason IN ('failed', 'partial', 'rate_limited', 'not_authorized')),
    PRIMARY KEY (repo, number)
  );
  CREATE TABLE IF NOT EXISTS pack_coding_ancestry_facts (
    repo TEXT NOT NULL,
    base_oid TEXT NOT NULL,
    head_oid TEXT NOT NULL,
    status TEXT CHECK (status IS NULL OR status IN ('ahead','identical','behind','diverged')),
    fact_revision INTEGER NOT NULL,
    observation_revision INTEGER NOT NULL,
    observed_at INTEGER,
    attempted_at INTEGER NOT NULL,
    reason TEXT CHECK (reason IS NULL OR reason IN ('failed','partial')),
    PRIMARY KEY (repo, base_oid, head_oid)
  );
  CREATE TABLE IF NOT EXISTS pack_coding_repo_aliases (
    alias TEXT PRIMARY KEY,
    canonical TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pack_coding_feature_sessions (
    repo TEXT NOT NULL,
    feature_key TEXT NOT NULL,
    todo_id TEXT NOT NULL,
    reserved_at INTEGER NOT NULL,
    PRIMARY KEY (repo, feature_key)
  );
  DROP TABLE IF EXISTS pack_coding_pr_unowned;
  CREATE TABLE IF NOT EXISTS pack_coding_pr_unowned_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    activated_at INTEGER NOT NULL
  );
  DROP TABLE IF EXISTS pack_coding_session_prs;
  DROP TABLE IF EXISTS pack_coding_pr_claims;
  DROP TABLE IF EXISTS pack_coding_session_facts;`);
  const heads = db.prepare('PRAGMA table_info(pack_coding_stage_heads)').all() as {
    name: string;
  }[];
  if (!heads.some((column) => column.name === 'observed_at'))
    db.exec(
      'ALTER TABLE pack_coding_stage_heads ADD COLUMN observed_at INTEGER NOT NULL DEFAULT 0'
    );
  const pages = db.prepare('PRAGMA table_info(pack_coding_poll_facts)').all() as { name: string }[];
  if (!pages.some((column) => column.name === 'http_json'))
    db.exec(
      'ALTER TABLE pack_coding_poll_facts ADD COLUMN http_json TEXT CHECK (http_json IS NULL OR json_valid(http_json))'
    );
  const ledger = db.prepare('PRAGMA table_info(pack_coding_pr_ledger)').all() as { name: string }[];
  for (const [column, definition] of [
    [
      'terminal_event_json',
      'TEXT CHECK (terminal_event_json IS NULL OR json_valid(terminal_event_json))',
    ],
    ['reply_at', 'INTEGER'],
    ['created_at', 'INTEGER'],
    ['author_is_bot', 'INTEGER NOT NULL DEFAULT 1'],
    ['updated_at', 'TEXT'],
  ])
    if (!ledger.some((item) => item.name === column))
      db.exec(`ALTER TABLE pack_coding_pr_ledger ADD COLUMN ${column} ${definition}`);
  const has = (table: string, column: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
      ({ name }) => name === column
    );
  if (has('pack_coding_daemon_merge_failures', 'notified_at'))
    db.exec('ALTER TABLE pack_coding_daemon_merge_failures DROP COLUMN notified_at');
  for (const column of ['pending_key', 'pending_text', 'pending_rows'])
    if (has('pack_coding_pr_unowned_state', column))
      db.exec(`ALTER TABLE pack_coding_pr_unowned_state DROP COLUMN ${column}`);
  for (const table of ['pack_coding_pr_event_state', 'pack_coding_pr_unowned_state'])
    db.prepare(`INSERT OR IGNORE INTO ${table} (id, activated_at) VALUES (1, ?)`).run(activatedAt);
}

import type { Database } from '../../../../../storage/sqlite-compat.ts';

export function createCodingPackTables(db: Database, activatedAt = Date.now()): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pack_coding_todo_prs (
    todo_id TEXT PRIMARY KEY REFERENCES neo_todos(id) ON DELETE CASCADE,
    prs_json TEXT NOT NULL CHECK (json_valid(prs_json)),
    read_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pack_coding_pr_claims (
    todo_id TEXT NOT NULL REFERENCES neo_todos(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    claim TEXT NOT NULL CHECK (claim IN ('named', 'reported', 'branch')),
    claimed_at INTEGER NOT NULL,
    PRIMARY KEY (todo_id, url)
  );
  CREATE INDEX IF NOT EXISTS idx_pack_coding_pr_claims_url ON pack_coding_pr_claims(url);
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
  CREATE TABLE IF NOT EXISTS pack_coding_repo_aliases (
    alias TEXT PRIMARY KEY,
    canonical TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pack_coding_pr_unowned (
    key TEXT PRIMARY KEY,
    listed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pack_coding_pr_unowned_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    activated_at INTEGER NOT NULL,
    pending_key TEXT,
    pending_text TEXT
  );
  DROP TABLE IF EXISTS pack_coding_session_prs;
  CREATE TABLE IF NOT EXISTS pack_coding_session_facts (
    ref TEXT PRIMARY KEY CHECK (json_valid(ref)),
    repos TEXT NOT NULL CHECK (json_valid(repos)),
    branches TEXT NOT NULL CHECK (json_valid(branches)),
    linked TEXT CHECK (linked IS NULL OR json_valid(linked)),
    linked_window INTEGER NOT NULL DEFAULT 0,
    owned TEXT NOT NULL CHECK (json_valid(owned)),
    opened TEXT NOT NULL CHECK (json_valid(opened)),
    dismissed TEXT NOT NULL CHECK (json_valid(dismissed)),
    active_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL
  )`);
  const ledger = db.prepare('PRAGMA table_info(pack_coding_pr_ledger)').all() as { name: string }[];
  if (!ledger.some((column) => column.name === 'reply_at'))
    db.exec('ALTER TABLE pack_coding_pr_ledger ADD COLUMN reply_at INTEGER');
  if (!ledger.some((column) => column.name === 'created_at'))
    db.exec('ALTER TABLE pack_coding_pr_ledger ADD COLUMN created_at INTEGER');
  if (!ledger.some((column) => column.name === 'author_is_bot'))
    db.exec(
      'ALTER TABLE pack_coding_pr_ledger ADD COLUMN author_is_bot INTEGER NOT NULL DEFAULT 1'
    );
  db.prepare(
    'INSERT OR IGNORE INTO pack_coding_pr_unowned_state (id, activated_at) VALUES (1, ?)'
  ).run(activatedAt);
}

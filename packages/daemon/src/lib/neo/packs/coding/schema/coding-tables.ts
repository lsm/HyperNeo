import type { Database } from '../../../../../storage/sqlite-compat.ts';

export function createCodingPackTables(db: Database): void {
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
  CREATE TABLE IF NOT EXISTS pack_coding_session_prs (
    url TEXT PRIMARY KEY,
    ref TEXT NOT NULL CHECK (json_valid(ref)),
    seen_at INTEGER NOT NULL
  )`);
  const ledger = db.prepare('PRAGMA table_info(pack_coding_pr_ledger)').all() as { name: string }[];
  if (!ledger.some((column) => column.name === 'reply_at'))
    db.exec('ALTER TABLE pack_coding_pr_ledger ADD COLUMN reply_at INTEGER');
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_todo_pr_refs'").get())
    db.exec(
      `INSERT OR IGNORE INTO neo_todo_pr_refs (reference, number, todo_id) ${CODING_TODO_PR_REFS}`
    );
}

export const CODING_TODO_PR_REFS = `SELECT
    lower(replace(json_extract(p.value, '$.url'), 'http://', 'https://')),
    CAST(substr(json_extract(p.value, '$.url'),
      length(rtrim(json_extract(p.value, '$.url'), '0123456789')) + 1) AS INTEGER),
    r.todo_id
  FROM pack_coding_todo_prs r, json_each(r.prs_json) p
  WHERE json_extract(p.value, '$.url') IS NOT NULL`;

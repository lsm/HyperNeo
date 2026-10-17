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
  CREATE INDEX IF NOT EXISTS idx_pack_coding_pr_claims_url ON pack_coding_pr_claims(url)`);
}

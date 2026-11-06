import type { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

export function seedPrOwner(db: Database, repo: string, ref: { adapter: string; id: string }) {
  const owner = JSON.stringify(ref).replaceAll("'", "''");
  const key = repo.replaceAll("'", "''");
  db.exec(`UPDATE pack_coding_pr_ledger SET owner = '${owner}' WHERE repo = '${key}';
    CREATE TRIGGER IF NOT EXISTS verify_seed_owner AFTER INSERT ON pack_coding_pr_ledger
    WHEN NEW.repo = '${key}' AND NEW.owner IS NULL BEGIN
      UPDATE pack_coding_pr_ledger SET owner = '${owner}' WHERE repo = NEW.repo AND number = NEW.number;
    END`);
}

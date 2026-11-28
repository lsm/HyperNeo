import type { Database } from '../sqlite-compat.ts';

export function runMigration543(db: Database): void {
  db.exec(`ALTER TABLE neo_memories ADD COLUMN embedding BLOB;
  ALTER TABLE neo_memories ADD COLUMN embedding_model TEXT`);
}

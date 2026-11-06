import type { Database } from '../sqlite-compat.ts';

export function runMigration480(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_turn_urls (
    url TEXT NOT NULL,
    ref TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    PRIMARY KEY (url, ref, turn_id)
  ) WITHOUT ROWID`);
  const columns = db.prepare('PRAGMA table_info(work_turns)').all() as { name: string }[];
  if (columns.some((column) => column.name === 'final_urls')) return;
  db.exec(`DELETE FROM work_turns;
    ALTER TABLE work_turns ADD COLUMN final_urls TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(final_urls));`);
}

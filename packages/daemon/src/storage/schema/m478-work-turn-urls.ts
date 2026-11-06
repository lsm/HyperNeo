import type { Database } from '../sqlite-compat.ts';

export function runMigration478(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_turn_urls (
    url TEXT NOT NULL,
    ref TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    PRIMARY KEY (url, ref, turn_id)
  ) WITHOUT ROWID;
  INSERT OR IGNORE INTO work_turn_urls (url, ref, turn_id)
    SELECT lower(urls.value), work_turns.ref, work_turns.id
    FROM work_turns, json_each(work_turns.urls) AS urls;`);
}

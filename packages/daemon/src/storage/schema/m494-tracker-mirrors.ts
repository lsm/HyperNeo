import type { Database } from '../sqlite-compat.ts';

export function runMigration494(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_tracker_mirrors (
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('ask','todo')), owner_id TEXT NOT NULL,
    tracker TEXT NOT NULL, home TEXT NOT NULL, ref TEXT, parent_ref TEXT,
    state TEXT NOT NULL CHECK(state IN ('creating','bound','closed')),
    failures INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
    PRIMARY KEY(owner_kind, owner_id, tracker)
  )`);
}

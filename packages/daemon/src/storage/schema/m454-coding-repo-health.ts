import type { Database } from '../sqlite-compat.ts';

export function runMigration454(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pack_coding_repo_health (
    repo TEXT PRIMARY KEY,
    health_json TEXT NOT NULL CHECK(json_valid(health_json))
  )`);
}

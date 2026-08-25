import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function runMigration215(db: BunDatabase): void {
  db.exec(`ALTER TABLE space_agents ADD COLUMN model_pool TEXT`);
}

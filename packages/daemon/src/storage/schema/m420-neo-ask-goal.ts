import type { Database } from '../sqlite-compat.ts';

export function runMigration420(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_asks)').all() as { name: string }[];
  if (!columns.length) return;
  if (!columns.some((column) => column.name === 'goal_id'))
    db.exec(
      'ALTER TABLE neo_asks ADD COLUMN goal_id TEXT REFERENCES space_goals(id) ON DELETE SET NULL'
    );
  db.exec('CREATE INDEX IF NOT EXISTS idx_neo_asks_goal ON neo_asks(goal_id)');
}

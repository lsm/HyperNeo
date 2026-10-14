import type { Database } from '../sqlite-compat.ts';

export function runMigration368(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_concerns)').all() as { name: string }[];
  if (!columns.length) return;
  if (!columns.some((column) => column.name === 'parent_id'))
    db.exec('ALTER TABLE neo_concerns ADD COLUMN parent_id TEXT REFERENCES neo_concerns(id)');
  if (!columns.some((column) => column.name === 'epic_url'))
    db.exec('ALTER TABLE neo_concerns ADD COLUMN epic_url TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_neo_project_parent ON neo_concerns(parent_id)');
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_neo_project_epic ON neo_concerns(epic_url) WHERE epic_url IS NOT NULL'
  );
}

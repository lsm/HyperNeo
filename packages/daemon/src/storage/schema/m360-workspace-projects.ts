import type { Database } from '../sqlite-compat.ts';

export function runMigration360(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspace_project_folders (
    path TEXT PRIMARY KEY REFERENCES workspace_history(path) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_workspace_project_folders_project
    ON workspace_project_folders(project_id)`);
}

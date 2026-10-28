import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { workspaceHistoryRemoveWrites } from './workspace-history-remove-write.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import type { WorkspaceHistoryEntry } from '@hyperneo/shared';

export interface WorkspaceHistoryRow {
  path: string;
  last_used_at: number;
  use_count: number;
}

export class WorkspaceHistoryRepository {
  constructor(private db: BunDatabase) {}

  projects(): NonNullable<WorkspaceHistoryEntry['project']>[] {
    const rows = this.db
      .prepare(`SELECT p.id, p.name, f.path FROM workspace_projects p
      JOIN workspace_project_folders f ON f.project_id = p.id ORDER BY p.id, f.path`)
      .all() as { id: string; name: string; path: string }[];
    const projects = new Map<string, NonNullable<WorkspaceHistoryEntry['project']>>();
    for (const row of rows) {
      const project = projects.get(row.id) ?? { id: row.id, name: row.name, folders: [] };
      project.folders.push(row.path);
      projects.set(row.id, project);
    }
    return [...projects.values()];
  }

  addProjectFolder(projectPath: string, path: string, name: string): boolean {
    return this.db.transaction(() => {
      const membership = this.db.prepare(
        'SELECT project_id FROM workspace_project_folders WHERE path = ?'
      );
      const target = membership.get(projectPath) as { project_id: string } | null;
      const current = membership.get(path) as { project_id: string } | null;
      if (current) return current.project_id === target?.project_id;
      const id = target?.project_id ?? crypto.randomUUID();
      this.db
        .prepare('INSERT OR IGNORE INTO workspace_projects (id, name) VALUES (?, ?)')
        .run(id, name);
      for (const folder of new Set([projectPath, path])) {
        this.upsert(folder);
        this.db
          .prepare(
            'INSERT OR IGNORE INTO workspace_project_folders (path, project_id) VALUES (?, ?)'
          )
          .run(folder, id);
      }
      return true;
    })();
  }

  entries(): WorkspaceHistoryEntry[] {
    const projects = new Map(
      this.projects().flatMap((project) => project.folders.map((path) => [path, project] as const))
    );
    return this.listAll().map((row) => ({
      path: row.path,
      lastUsedAt: row.last_used_at,
      useCount: row.use_count,
      ...(projects.has(row.path) ? { project: projects.get(row.path) } : {}),
    }));
  }

  upsert(path: string): WorkspaceHistoryRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workspace_history (path, last_used_at, use_count)
				 VALUES (?, ?, 1)
				 ON CONFLICT(path) DO UPDATE SET
				   last_used_at = excluded.last_used_at,
				   use_count = use_count + 1`
      )
      .run(path, now);
    return this.get(path)!;
  }

  get(path: string): WorkspaceHistoryRow | null {
    const row = this.db
      .prepare('SELECT path, last_used_at, use_count FROM workspace_history WHERE path = ?')
      .get(path) as WorkspaceHistoryRow | null;
    return row;
  }

  list(limit = 20): WorkspaceHistoryRow[] {
    return this.db
      .prepare(
        'SELECT path, last_used_at, use_count FROM workspace_history ORDER BY last_used_at DESC, id DESC LIMIT ?'
      )
      .all(limit) as WorkspaceHistoryRow[];
  }

  listAll(): WorkspaceHistoryRow[] {
    return this.db
      .prepare(
        'SELECT path, last_used_at, use_count FROM workspace_history ORDER BY last_used_at DESC, id DESC'
      )
      .all() as WorkspaceHistoryRow[];
  }

  removeAsync(path: string) {
    return gatewayFor(this.db).call(workspaceHistoryRemoveWrites, 'remove', path);
  }

  remove(path: string): boolean {
    return this.db.transaction(() => {
      const result = this.db.prepare('DELETE FROM workspace_history WHERE path = ?').run(path);
      this.db
        .prepare(`DELETE FROM workspace_projects WHERE NOT EXISTS (
        SELECT 1 FROM workspace_project_folders WHERE project_id = workspace_projects.id
      )`)
        .run();
      return result.changes > 0;
    })();
  }
}

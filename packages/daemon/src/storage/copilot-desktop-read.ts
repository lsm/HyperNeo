import { Database } from './sqlite-compat.ts';
import type {
  CopilotDesktopRead,
  CopilotDesktopSession,
} from '../lib/drivers/copilot-desktop-adapter.ts';

export function readCopilotDesktop({ statePath, id, query }: CopilotDesktopRead) {
  const app = new Database(statePath, { readonly: true });
  try {
    const rows = app.prepare(`
      WITH candidates AS (
        SELECT s.id, w.id AS workspaceId, COALESCE(NULLIF(s.title, ''), w.name) AS title,
               p.name AS project, COALESCE(NULLIF(p.main_repo_path, ''), w.source_path, t.path) AS folder,
               COALESCE(t.path, w.source_path, p.main_repo_path) AS directory,
               s.updated_at AS updatedAt, s.is_running AS running,
               s.was_interrupted AS interrupted,
               (w.archived_at IS NOT NULL OR s.archived_at IS NOT NULL) AS archived
          FROM sessions s
          JOIN workspaces w ON w.session_id = s.id
          JOIN projects p ON p.id = w.project_id
          LEFT JOIN worktrees t ON t.id = w.worktree_id
         WHERE s.execution_location = 'local' AND s.provisional = 0
           AND w.host_id = 'local' AND w.workspace_type <> 'cloud'
           AND s.id = coalesce(?, s.id)
           AND instr(s.id, ?) = 1
      )
      SELECT id, workspaceId, title, project, folder, directory, updatedAt, running, interrupted, archived
        FROM candidates
       WHERE (? OR NOT archived)
         AND folder = coalesce(?, folder)
         AND (instr(lower(title), ?) OR instr(lower(project), ?) OR instr(lower(folder), ?))
       ORDER BY updatedAt DESC, id
    `);
    const text = query.text?.toLowerCase() ?? '';
    return rows.all(
      id ?? null,
      query.idPrefix ?? '',
      Number(query.includeClosed),
      query.folder ?? null,
      text,
      text,
      text
    ) as CopilotDesktopSession[];
  } finally {
    app.close();
  }
}

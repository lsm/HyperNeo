import { pathToFileURL } from 'node:url';
import { Database } from './sqlite-compat.ts';
import type {
  CopilotDesktopRead,
  CopilotDesktopSession,
} from '../lib/drivers/copilot-desktop-adapter.ts';

function readOnce({ statePath, id, query }: CopilotDesktopRead, readonlyUri = false) {
  const app = new Database(statePath, { readonly: true, readonlyUri });
  try {
    app.exec('PRAGMA busy_timeout = 2000');
    const columns = new Set(
      (app.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(
        (column) => column.name
      )
    );
    const settings = [
      ...(columns.has('model') ? ['s.model AS model'] : []),
      ...(columns.has('reasoning_effort') ? ['s.reasoning_effort AS effort'] : []),
    ];
    const settingsSql = settings.length ? `, ${settings.join(', ')}` : '';
    const rows = app.prepare(`
      WITH candidates AS (
        SELECT s.id, w.id AS workspaceId,
               COALESCE(NULLIF(s.title, ''), NULLIF(w.name, ''), 'Untitled session') AS title,
               p.name AS project, COALESCE(NULLIF(p.main_repo_path, ''), w.source_path, t.path) AS folder,
               COALESCE(t.path, w.source_path, p.main_repo_path) AS directory,
               s.updated_at AS updatedAt, s.is_running AS running,
               s.was_interrupted AS interrupted,
               (w.archived_at IS NOT NULL OR s.archived_at IS NOT NULL) AS archived${settingsSql}
          FROM sessions s
          JOIN workspaces w ON w.session_id = s.id
          JOIN projects p ON p.id = w.project_id
          LEFT JOIN worktrees t ON t.id = w.worktree_id
         WHERE s.execution_location = 'local' AND s.provisional = 0
           AND w.host_id = 'local' AND w.workspace_type <> 'cloud'
           AND s.id = coalesce(?, s.id)
           AND instr(s.id, ?) = 1
      )
      SELECT *
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
  } catch (error) {
    if (/no such (?:table|column)/.test(String(error)))
      throw new Error(`Unsupported Copilot Desktop state schema: ${String(error)}`, {
        cause: error,
      });
    throw error;
  } finally {
    app.close();
  }
}

export function readCopilotDesktop(args: CopilotDesktopRead) {
  try {
    return readOnce(args);
  } catch (error) {
    if (!/unable to open database file|readonly database/.test(String(error))) throw error;
    const url = pathToFileURL(args.statePath);
    url.searchParams.set('immutable', '1');
    return readOnce({ ...args, statePath: url.href }, true);
  }
}

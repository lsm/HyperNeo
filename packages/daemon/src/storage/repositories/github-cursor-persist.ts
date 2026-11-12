import type { Database } from '../sqlite-compat.ts';
import type { PollCursor } from '../../lib/external-events/github/github-repository.ts';
import { gitHubWatchedTableForId } from './github-scope.ts';

export function persistGitHubPollCursorJson(db: Database, id: string, cursor: PollCursor): void {
  const table = gitHubWatchedTableForId(db, id);
  if (!table) return;
  db.prepare(`UPDATE ${table} SET poll_cursor = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(cursor),
    Date.now(),
    id
  );
}

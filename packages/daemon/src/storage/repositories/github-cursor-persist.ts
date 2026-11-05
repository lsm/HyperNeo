import type { Database } from '../sqlite-compat.ts';
import type { PollCursor } from '../../lib/external-events/github/github-repository.ts';

export function persistGitHubPollCursorJson(db: Database, id: string, cursor: PollCursor): void {
  db.prepare(
    `UPDATE space_github_watched_repos SET poll_cursor = ?, updated_at = ? WHERE id = ?`
  ).run(JSON.stringify(cursor), Date.now(), id);
}
